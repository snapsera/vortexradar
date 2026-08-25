const map = require('../../core/map/map');
const map_funcs = require('../../core/map/mapFunctions');
const setLayerOrder = require('../../core/map/setLayerOrder');
const ut = require('../../core/utils');
const settings_store = require('../../core/menu/settings_store');

function _radar_opacity() {
    if (window.stormTrackData?.radarOpacity != null) return window.stormTrackData.radarOpacity;
    var s = settings_store.load();
    return s.radarOpacity / 100;
}

const SOURCE_ID = 'nationalRadarSource';
const LAYER_ID = 'nationalRadarLayer';
const MRMS_LAYER_NAME = 'weather_radar:conus_base_reflectivity_mosaic';
const MRMS_BASE_FRAME_MS = 600;
const MRMS_SPEED_MULTIPLIER = 10;
const MRMS_ENDPOINT_DWELL_MS = 1100;
const MRMS_FRAME_COUNT = 14;
const MRMS_TIMES_REFRESH_MS = 120000;

const MRMS_WMS_BASE_URL = 'https://nowcoast.noaa.gov/geoserver/weather_radar/wms?service=WMS&version=1.3.0&request=GetMap&layers=weather_radar:conus_base_reflectivity_mosaic&styles=&format=image/png&transparent=true&width=256&height=256&crs=EPSG:3857&bbox={bbox-epsg-3857}';
const MRMS_WMS_CAPABILITIES_URL = 'https://nowcoast.noaa.gov/geoserver/ows?service=WMS&version=1.3.0&request=GetCapabilities';

const state = {
    enabled: false,
    frames: [],
    currentIndex: 0,
    playDirection: 1,
    playTimer: null,
    refreshTimer: null
};

function _ensure_diag_state() {
    if (!window.stormTrackData) window.stormTrackData = {};
    if (!window.stormTrackData.usRadarMrms) window.stormTrackData.usRadarMrms = {};
    return window.stormTrackData.usRadarMrms;
}

function _frame_url(timeValue = null) {
    if (!timeValue) return MRMS_WMS_BASE_URL;
    return `${MRMS_WMS_BASE_URL}&time=${encodeURIComponent(timeValue)}`;
}

function _set_tiles(frameUrl) {
    const source = map.getSource(SOURCE_ID);
    if (source && typeof source.setTiles === 'function') {
        source.setTiles([frameUrl]);
        return;
    }

    // Some MapLibre GL versions do not expose setTiles() on raster sources.
    // Update the source internals in-place to avoid remove/add flicker each frame.
    if (source && Array.isArray(source.tiles) && map?.style?.sourceCaches?.[SOURCE_ID]) {
        source.tiles = [frameUrl];
        const sourceCache = map.style.sourceCaches[SOURCE_ID];
        if (typeof sourceCache.clearTiles === 'function') {
            sourceCache.clearTiles();
        }
        if (typeof sourceCache.update === 'function') {
            sourceCache.update(map.transform);
        }
        map.triggerRepaint();
        return;
    }

    if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);

    map.addSource(SOURCE_ID, {
        type: 'raster',
        tiles: [frameUrl],
        tileSize: 256,
        attribution: 'NOAA nowCOAST'
    });
    map.addLayer({
        id: LAYER_ID,
        type: 'raster',
        source: SOURCE_ID,
        paint: {
            'raster-opacity': _radar_opacity(),
            'raster-fade-duration': 0
        }
    }, map_funcs.get_base_layer());
}

function _ensure_layer() {
    if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, {
            type: 'raster',
            tiles: [_frame_url()],
            tileSize: 256,
            attribution: 'NOAA nowCOAST'
        });
    }
    if (!map.getLayer(LAYER_ID)) {
        map.addLayer({
            id: LAYER_ID,
            type: 'raster',
            source: SOURCE_ID,
            paint: {
                'raster-opacity': _radar_opacity(),
                'raster-fade-duration': 0
            }
        }, map_funcs.get_base_layer());
    }
}

function _stop_timers() {
    if (state.playTimer) {
        clearTimeout(state.playTimer);
        state.playTimer = null;
    }
    if (state.refreshTimer) {
        clearInterval(state.refreshTimer);
        state.refreshTimer = null;
    }
}

function _parse_times_from_capabilities(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const layers = doc.getElementsByTagName('Layer');
    for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        const nameNode = layer.getElementsByTagName('Name')[0];
        if (!nameNode || nameNode.textContent !== MRMS_LAYER_NAME) continue;
        const dimensions = layer.getElementsByTagName('Dimension');
        for (let j = 0; j < dimensions.length; j++) {
            const dimension = dimensions[j];
            if (dimension.getAttribute('name') !== 'time') continue;
            const rawText = (dimension.textContent || '').trim();
            if (!rawText) return [];
            return rawText.split(',').map((v) => v.trim()).filter(Boolean);
        }
    }
    return [];
}

function _parse_times_fallback(xmlText) {
    const layerMatch = xmlText.match(/<Name>\s*weather_radar:conus_base_reflectivity_mosaic\s*<\/Name>[\s\S]*?<Dimension[^>]*name=["']time["'][^>]*>([\s\S]*?)<\/Dimension>/i);
    if (!layerMatch || !layerMatch[1]) return [];
    return layerMatch[1].split(',').map((v) => v.trim()).filter(Boolean);
}

function _default_recent_times() {
    const out = [];
    const nowMs = Date.now();
    const stepMs = 4 * 60 * 1000;
    for (let i = MRMS_FRAME_COUNT - 1; i >= 0; i--) {
        out.push(new Date(nowMs - (i * stepMs)).toISOString());
    }
    return out;
}

function _fetch_available_times(callback) {
    const diag = _ensure_diag_state();
    diag.capabilitiesFetchStartedAt = new Date().toISOString();

    function finalize(xmlText) {
        try {
            let allTimes = _parse_times_from_capabilities(xmlText);
            if (!allTimes.length) {
                allTimes = _parse_times_fallback(xmlText);
            }
            if (!allTimes.length) {
                diag.framesSource = 'fallback-generated';
                callback(_default_recent_times());
                return;
            }
            diag.framesSource = 'capabilities-time-dimension';
            callback(allTimes.slice(Math.max(allTimes.length - MRMS_FRAME_COUNT, 0)));
        } catch (_) {
            diag.framesSource = 'fallback-generated';
            callback(_default_recent_times());
        }
    }

    $.get(MRMS_WMS_CAPABILITIES_URL, (xmlText) => {
        diag.capabilitiesFetchPath = 'direct';
        finalize(xmlText);
    }).fail(() => {
        // corsproxy.io expects a URL in the querystring; raw value is accepted.
        $.get(`${ut.phpProxy}${MRMS_WMS_CAPABILITIES_URL}`, (xmlText) => {
            diag.capabilitiesFetchPath = 'proxy-raw';
            finalize(xmlText);
        }).fail(() => {
            // Keep a final encoded fallback for environments that require it.
            $.get(`${ut.phpProxy}${encodeURIComponent(MRMS_WMS_CAPABILITIES_URL)}`, (xmlText) => {
                diag.capabilitiesFetchPath = 'proxy-encoded';
                finalize(xmlText);
            }).fail(() => {
                diag.capabilitiesFetchPath = 'fallback-generated';
                callback(_default_recent_times());
            });
        });
    });
}

function _plot_current_frame() {
    if (!state.frames.length) return;
    const diag = _ensure_diag_state();
    const currentTime = state.frames[state.currentIndex];
    const frameUrl = _frame_url(currentTime);
    _set_tiles(frameUrl);
    diag.currentFrameIndex = state.currentIndex;
    diag.lastAppliedFrameTime = currentTime;
    diag.activeTileUrl = frameUrl;
}

function _schedule_next_tick() {
    if (!state.enabled || state.frames.length <= 1) return;
    const maxIdx = state.frames.length - 1;
    const isEndpoint = state.currentIndex === 0 || state.currentIndex === maxIdx;
    const frameDelayMs = MRMS_BASE_FRAME_MS / MRMS_SPEED_MULTIPLIER;
    const delay = frameDelayMs + (isEndpoint ? MRMS_ENDPOINT_DWELL_MS : 0);

    state.playTimer = setTimeout(() => {
        state.playTimer = null;
        if (!state.enabled || !state.frames.length) return;
        const nowMaxIdx = state.frames.length - 1;
        if (state.currentIndex >= nowMaxIdx) {
            state.playDirection = -1;
        } else if (state.currentIndex <= 0) {
            state.playDirection = 1;
        }
        state.currentIndex += state.playDirection;
        if (state.currentIndex < 0) state.currentIndex = 0;
        if (state.currentIndex > nowMaxIdx) state.currentIndex = nowMaxIdx;
        _plot_current_frame();
        _schedule_next_tick();
    }, delay);
}

function _refresh_frames_and_restart() {
    if (!state.enabled) return;
    _fetch_available_times((times) => {
        const diag = _ensure_diag_state();
        if (!state.enabled) return;
        if (!times.length) {
            state.frames = [];
            state.currentIndex = 0;
            _set_tiles(_frame_url());
            diag.activeFrameCount = 0;
            diag.lastAppliedFrameTime = null;
            setLayerOrder();
            return;
        }

        const currentTime = state.frames[state.currentIndex];
        state.frames = times;
        if (currentTime) {
            const matchedIndex = state.frames.indexOf(currentTime);
            state.currentIndex = matchedIndex >= 0 ? matchedIndex : 0;
        } else {
            state.currentIndex = 0;
        }
        state.playDirection = 1;

        if (state.playTimer) {
            clearTimeout(state.playTimer);
            state.playTimer = null;
        }
        diag.activeFrameCount = state.frames.length;
        diag.lastParsedFrameTime = state.frames[state.frames.length - 1];
        _plot_current_frame();
        _schedule_next_tick();
    });
}

function enable() {
    const diag = _ensure_diag_state();
    state.enabled = true;
    _ensure_layer();
    map.setLayoutProperty(LAYER_ID, 'visibility', 'visible');
    diag.sourceName = 'MRMS_CONUS_BASE_REFLECTIVITY_MOSAIC';
    diag.sourceUrl = MRMS_WMS_BASE_URL;
    diag.enabled = true;
    diag.targetFrameCount = MRMS_FRAME_COUNT;
    diag.speedMultiplier = MRMS_SPEED_MULTIPLIER;
    diag.enabledAt = new Date().toISOString();
    state.playDirection = 1;
    _refresh_frames_and_restart();
    if (!state.refreshTimer) {
        state.refreshTimer = setInterval(_refresh_frames_and_restart, MRMS_TIMES_REFRESH_MS);
    }
    setLayerOrder();
}

function disable() {
    const diag = _ensure_diag_state();
    state.enabled = false;
    state.frames = [];
    state.currentIndex = 0;
    state.playDirection = 1;
    _stop_timers();
    diag.enabled = false;
    diag.disabledAt = new Date().toISOString();

    if (map.getLayer(LAYER_ID)) {
        map.removeLayer(LAYER_ID);
    }
    if (map.getSource(SOURCE_ID)) {
        map.removeSource(SOURCE_ID);
    }
}

function isEnabled() {
    return !!map.getLayer(LAYER_ID);
}

module.exports = {
    enable,
    disable,
    isEnabled,
    SOURCE_ID,
    LAYER_ID
};
