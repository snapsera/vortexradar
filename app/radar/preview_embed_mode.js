const map = require('../core/map/map');
const station_markers = require('./station_markers/station_markers');
const radar_scan_animation = require('./station_markers/radar_scan_animation');
const loaders_nexrad = require('./libnexrad/loaders_nexrad');
const { precompute_render_data } = require('./plot/calculate_coordinates');
const plot_to_map = require('./plot/plot_to_map');
const { NEXRAD_LOCATIONS } = require('./libnexrad/nexrad_locations');
const { get_closest_wsr88d_radar } = require('../alerts/alert_helpers');

var _previewRefreshTimer = null;
var _previewFrames = [];
var _previewFrameIndex = 0;
var _previewFactoryCache = {};
var _previewRenderCache = {};
var _previewRafId = null;
var _previewLastStepAt = 0;
var _previewFrameDelayMs = 60;
var _previewEndpointDwellMs = 1100;
var _previewReadySignaled = false;

function _is_enabled() {
    try {
        return new URLSearchParams(window.location.search).get('radarPreview') === '1';
    } catch (_) {
        return false;
    }
}

function _get_coords() {
    var params = new URLSearchParams(window.location.search);
    var lat = parseFloat(params.get('lat'));
    var lon = parseFloat(params.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat: lat, lon: lon };
}

function _hide_app_chrome() {
    var keep = { map: true };
    $('#bodyDiv').children().each(function() {
        if (!keep[this.id]) $(this).hide();
    });

    $('html, body').css({
        margin: '0',
        padding: '0',
        overflow: 'hidden',
        background: '#050b14'
    });
    $('#bodyDiv').css({
        margin: '0',
        padding: '0',
        width: '100vw',
        height: '100vh',
        display: 'block',
        visibility: 'visible'
    });
    $('#map').css({
        position: 'fixed',
        top: '0',
        left: '0',
        width: '100vw',
        height: '100vh',
        zIndex: '1',
        pointerEvents: 'none'
    });
}

function _hide_station_markers() {
    if (!map || !map.getLayer || !map.setLayoutProperty) return;
    if (map.getLayer('stationSymbolLayer')) {
        map.setLayoutProperty('stationSymbolLayer', 'visibility', 'none');
    }
}

function _mark_preview_ready() {
    if (_previewReadySignaled) return;
    _previewReadySignaled = true;
    window.dispatchEvent(new CustomEvent('radarPreviewReady'));
}

function _ensure_station_markers_hidden() {
    var attempts = 0;
    var timer = setInterval(function() {
        attempts++;
        _hide_station_markers();
        if (attempts > 30) clearInterval(timer);
    }, 500);
}

function _refresh_preview_frames(stationId, cb) {
    loaders_nexrad.get_latest_level_3_frames(stationId, 'N0B', 14, function(frames) {
        _previewFrames = Array.isArray(frames) ? frames : [];
        if (_previewFrameIndex >= _previewFrames.length) _previewFrameIndex = 0;
        if (cb) cb();
    });
}

function _prepare_preview_frames(cb) {
    if (!_previewFrames.length) {
        if (cb) cb();
        return;
    }
    var urls = _previewFrames.map(function(frame) {
        return frame && frame.url ? frame.url : null;
    }).filter(Boolean);
    var uncached = urls.filter(function(url) {
        return !_previewFactoryCache[url];
    });
    var missingRender = urls.filter(function(url) {
        return !_previewRenderCache[url];
    });
    if (!uncached.length && !missingRender.length) {
        if (cb) cb();
        return;
    }
    var tasks = [];
    uncached.forEach(function(url) {
        tasks.push(function(next) {
            loaders_nexrad.return_level_3_factory_from_url(url, function(factory) {
                if (factory) _previewFactoryCache[url] = factory;
                next();
            });
        });
    });
    missingRender.forEach(function(url) {
        tasks.push(function(next) {
            var factory = _previewFactoryCache[url];
            if (factory) {
                precompute_render_data(factory, function(renderData) {
                    _previewRenderCache[url] = renderData;
                    next();
                });
            } else {
                loaders_nexrad.return_level_3_factory_from_url(url, function(loadedFactory) {
                    if (!loadedFactory) {
                        next();
                        return;
                    }
                    _previewFactoryCache[url] = loadedFactory;
                    precompute_render_data(loadedFactory, function(renderDataLoaded) {
                        _previewRenderCache[url] = renderDataLoaded;
                        next();
                    });
                });
            }
        });
    });

    var i = 0;
    var inFlight = 0;
    var CONCURRENCY = 4;
    function pump() {
        if (i >= tasks.length && inFlight === 0) {
            if (cb) cb();
            return;
        }
        while (inFlight < CONCURRENCY && i < tasks.length) {
            var task = tasks[i++];
            inFlight++;
            task(function() {
                inFlight--;
                pump();
            });
        }
    }
    pump();
}

function _plot_preview_frame(frame) {
    if (!frame || !frame.url) return;
    var renderData = _previewRenderCache[frame.url];
    var factory = _previewFactoryCache[frame.url];
    if (renderData && factory) {
        var swapped = plot_to_map.update_radar_buffers(
            renderData.vertices,
            renderData.colors,
            renderData.product,
            factory
        );
        if (swapped) return;
    }
    if (factory && factory.plot) {
        factory.plot();
        return;
    }
    loaders_nexrad.return_level_3_factory_from_url(frame.url, function(loadedFactory) {
        if (!loadedFactory || !loadedFactory.plot) return;
        _previewFactoryCache[frame.url] = loadedFactory;
        loadedFactory.plot();
        precompute_render_data(loadedFactory, function(renderDataLoaded) {
            _previewRenderCache[frame.url] = renderDataLoaded;
        });
    });
}

function _start_preview_playback(stationId) {
    if (_previewRafId != null) {
        cancelAnimationFrame(_previewRafId);
        _previewRafId = null;
    }
    if (_previewRefreshTimer) {
        clearInterval(_previewRefreshTimer);
        _previewRefreshTimer = null;
    }
    _refresh_preview_frames(stationId, function() {
        _prepare_preview_frames(function() {
            if (_previewFrames.length) {
                _plot_preview_frame(_previewFrames[_previewFrameIndex]);
            }
            _previewLastStepAt = 0;
            var tick = function(ts) {
                if (!_previewFrames.length) {
                    _previewRafId = requestAnimationFrame(tick);
                    return;
                }
                if (!_previewLastStepAt) _previewLastStepAt = ts;
                var isEndpoint = (_previewFrameIndex === _previewFrames.length - 1) && _previewFrames.length > 1;
                var delayMs = _previewFrameDelayMs + (isEndpoint ? _previewEndpointDwellMs : 0);
                if (ts - _previewLastStepAt >= delayMs) {
                    _previewFrameIndex = (_previewFrameIndex + 1) % _previewFrames.length;
                    _plot_preview_frame(_previewFrames[_previewFrameIndex]);
                    _previewLastStepAt = ts;
                }
                _previewRafId = requestAnimationFrame(tick);
            };
            _previewRafId = requestAnimationFrame(tick);
            _mark_preview_ready();
        });
    });

    _previewRefreshTimer = setInterval(function() {
        _refresh_preview_frames(stationId, function() {
            _prepare_preview_frames();
        });
    }, 45000);
}

function _focus_target(coords) {
    if (!map || !map.flyTo) return;
    map.flyTo({
        center: [coords.lon, coords.lat],
        zoom: 8.1,
        duration: 0
    });
}

function _keep_focus_locked(coords) {
    var attempts = 0;
    var timer = setInterval(function() {
        attempts++;
        _focus_target(coords);
        if (attempts >= 12) clearInterval(timer);
    }, 500);
}

function _run() {
    var coords = _get_coords();
    if (!coords) return;

    _hide_app_chrome();
    if (map && map.resize) map.resize();
    if (map) {
        try { if (map.dragPan && map.dragPan.disable) map.dragPan.disable(); } catch (_) {}
        try { if (map.scrollZoom && map.scrollZoom.disable) map.scrollZoom.disable(); } catch (_) {}
        try { if (map.boxZoom && map.boxZoom.disable) map.boxZoom.disable(); } catch (_) {}
        try { if (map.doubleClickZoom && map.doubleClickZoom.disable) map.doubleClickZoom.disable(); } catch (_) {}
        try { if (map.touchZoomRotate && map.touchZoomRotate.disable) map.touchZoomRotate.disable(); } catch (_) {}
        try { if (map.keyboard && map.keyboard.disable) map.keyboard.disable(); } catch (_) {}
    }
    _focus_target(coords);

    var nearest = get_closest_wsr88d_radar(coords.lon, coords.lat);
    if (nearest && NEXRAD_LOCATIONS[nearest]) {
        station_markers.selectStation(nearest, NEXRAD_LOCATIONS[nearest].type || 'WSR-88D', { persist: false });
        radar_scan_animation.remove();
        _start_preview_playback(nearest);
    } else {
        _mark_preview_ready();
    }

    setTimeout(_hide_station_markers, 200);
    setTimeout(_hide_station_markers, 1000);
    _ensure_station_markers_hidden();
    _keep_focus_locked(coords);
}

function init() {
    if (!_is_enabled()) return;
    document.documentElement.classList.add('radarPreviewEmbed');
    if (!window.stormTrackData) window.stormTrackData = {};
    window.stormTrackData.radarPreviewMode = true;
    window.addEventListener('radarBaseFactoryLoaded', function() {
        var station = window.stormTrackData && window.stormTrackData.currentStation;
        if (station) {
            radar_scan_animation.remove();
            _start_preview_playback(station);
        }
    });
    setTimeout(_mark_preview_ready, 12000);
    setTimeout(_run, 250);
}

module.exports = { init: init };
