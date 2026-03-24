const map = require('../core/map/map');
const get_polygon_colors = require('./colors/polygon_colors');
const alerts_display_state = require('./alerts_display_state');
const set_layer_order = require('../core/map/setLayerOrder');
const click_listener = require('./click_listener');
const turf = require('@turf/turf');

const WATCH_SOURCE_ID = 'watches_source';
const WATCH_FILL_ID = 'watches_layer_fill';
const WATCH_LINE_BORDER_ID = 'watches_layer_border';
const WATCH_LINE_ID = 'watches_layer';
const ZONE_FETCH_CONCURRENCY = 8;

const zoneCache = new Map();
let _lastRenderedKey = '';
let _updateInProgress = false;
let lastStats = {
    active_watch_alerts: 0,
    rendered_watch_zones: 0,
    zone_fetch_errors: 0
};

function _record_perf(durationMs, renderedCount) {
    if (typeof window === 'undefined' || !window.stormTrackData) return;
    const perf = window.stormTrackData.perf = window.stormTrackData.perf || {};
    perf.watchOverlayCalls = (perf.watchOverlayCalls || 0) + 1;
    perf.watchOverlayLastMs = durationMs;
    perf.watchOverlayRendered = renderedCount;
}

function _is_watch_event(event) {
    return !!event && (event.endsWith('Watch') || event.includes(' Watch'));
}

function _is_winter_overlay_event(event) {
    if (!event) return false;
    const winterEvents = alerts_display_state.ALERT_TYPES_BY_CATEGORY?.Winter || [];
    return winterEvents.includes(event);
}

function _is_county_overlay_event(event) {
    if (!event) return false;
    // County-first products requested by ops:
    // - all advisories
    // - freeze warnings
    // - wind/red-flag warnings and advisories
    // - heat advisories
    if (event.includes('Advisory')) return true;
    if (event.includes('Special Weather Statement')) return true;

    const isWarning = event.endsWith('Warning') || event.includes(' Warning');
    if (!isWarning) return false;

    if (event.includes('Freeze')) return true;
    if (event.includes('Wind')) return true;
    if (event.includes('Red Flag')) return true;
    return false;
}

function _is_overlay_event(event) {
    return _is_watch_event(event) || _is_winter_overlay_event(event) || _is_county_overlay_event(event);
}

function _normalize_zone_url(url) {
    if (!url || typeof url !== 'string') return null;
    return url.split('?')[0].replace(/\/+$/, '');
}

function _zone_type_from_url(url) {
    const normalized = _normalize_zone_url(url);
    if (!normalized) return null;
    if (normalized.includes('/zones/county/')) return 'county';
    if (normalized.includes('/zones/forecast/')) return 'forecast';
    if (normalized.includes('/zones/fire/')) return 'fire';
    if (normalized.includes('/zones/marine/')) return 'marine';
    return null;
}

async function _fetch_zone_feature(zoneUrl) {
    const normalized = _normalize_zone_url(zoneUrl);
    if (!normalized) return null;
    if (zoneCache.has(normalized)) return zoneCache.get(normalized);

    try {
        const headers = new Headers();
        headers.append('User-Agent', '(Vortex Radar, https://vortexradar.snapsera.com)');
        headers.append('Accept', 'application/geo+json');
        const response = await fetch(normalized, { headers });
        if (!response.ok) throw new Error(`Zone API ${response.status}`);
        const data = await response.json();
        let feature = null;
        if (data?.type === 'Feature') feature = data;
        else if (data?.type === 'FeatureCollection' && Array.isArray(data.features) && data.features[0]) feature = data.features[0];
        zoneCache.set(normalized, feature);
        return feature;
    } catch (_) {
        lastStats.zone_fetch_errors += 1;
        zoneCache.set(normalized, null);
        return null;
    }
}

function _upsert_layers(fc) {
    if (map.getSource(WATCH_SOURCE_ID)) {
        map.getSource(WATCH_SOURCE_ID).setData(fc);
        return;
    }

    const fillOpacity = (window.stormTrackData && window.stormTrackData.alertFillOpacity != null) ? window.stormTrackData.alertFillOpacity : 0.1;
    const bScale = (window.stormTrackData && window.stormTrackData.alertBorderScale != null) ? window.stormTrackData.alertBorderScale : 0.75;

    map.addSource(WATCH_SOURCE_ID, {
        type: 'geojson',
        data: fc
    });

    map.addLayer({
        id: WATCH_FILL_ID,
        type: 'fill',
        source: WATCH_SOURCE_ID,
        paint: {
            'fill-color': ['get', 'color'],
            'fill-opacity': fillOpacity
        }
    });

    map.addLayer({
        id: WATCH_LINE_BORDER_ID,
        type: 'line',
        source: WATCH_SOURCE_ID,
        paint: {
            'line-color': 'black',
            'line-width': 2.4 * bScale,
            'line-opacity': 0.7
        }
    });

    map.addLayer({
        id: WATCH_LINE_ID,
        type: 'line',
        source: WATCH_SOURCE_ID,
        paint: {
            'line-color': ['get', 'color'],
            'line-width': 1.2 * bScale,
            'line-opacity': 0.85
        }
    });

    map.on('mouseover', WATCH_FILL_ID, function () {
        map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseout', WATCH_FILL_ID, function () {
        map.getCanvas().style.cursor = '';
    });
    map.on('click', WATCH_FILL_ID, click_listener);

    set_layer_order();
}

async function update_from_alerts_data(alerts_data) {
    if (_updateInProgress) return;
    _updateInProgress = true;
    const start = performance.now();
    const features = alerts_data?.features || [];
    const activeWatchAlerts = features.filter((f) => {
        const event = f?.properties?.event || '';
        if (!_is_overlay_event(event)) return false;
        if (event === 'Special Weather Statement') {
            if (f?.geometry) return false;
            return alerts_display_state.get_alert_type_enabled('Special Weather Statement (County)');
        }
        return alerts_display_state.get_alert_type_enabled(event);
    });
    lastStats.active_watch_alerts = activeWatchAlerts.length;
    lastStats.zone_fetch_errors = 0;

    const rendered = [];
    const dedupe = new Set();
    const zoneFetchQueue = [];
    for (const alertFeature of activeWatchAlerts) {
        const p = alertFeature.properties || {};
        const event = p.event || '';
        const color = get_polygon_colors(p.event || '').color;
        const alertId = alertFeature.id || p.id || `${p.event || 'Watch'}|${p.sent || ''}`;
        const zones = p.affectedZones || [];
        const zoneItems = zones
            .map((z) => ({ raw: z, normalized: _normalize_zone_url(z), zoneType: _zone_type_from_url(z) }))
            .filter((z) => !!z.normalized);
        const countyZoneItems = zoneItems.filter((z) => z.zoneType === 'county');
        const preferCountyOnly =
            (_is_watch_event(event) || _is_winter_overlay_event(event) || _is_county_overlay_event(event)) &&
            countyZoneItems.length > 0;
        const zonesToRender = preferCountyOnly ? countyZoneItems : zoneItems;

        for (const zoneItem of zonesToRender) {
            const normalized = zoneItem.normalized;
            const key = `${alertId}|${normalized}`;
            if (dedupe.has(key)) continue;
            dedupe.add(key);

            zoneFetchQueue.push({
                raw: zoneItem.raw,
                alertId,
                color,
                properties: p
            });
        }

        // Fallback for rare payloads that include geometry but no resolvable zones.
        if (zonesToRender.length === 0 && alertFeature.geometry) {
            rendered.push({
                type: 'Feature',
                geometry: alertFeature.geometry,
                properties: Object.assign({}, p, {
                    id: alertId,
                    color
                })
            });
        }
    }

    for (let i = 0; i < zoneFetchQueue.length; i += ZONE_FETCH_CONCURRENCY) {
        const batch = zoneFetchQueue.slice(i, i + ZONE_FETCH_CONCURRENCY);
        const results = await Promise.allSettled(batch.map(async (task) => {
            const zoneFeature = await _fetch_zone_feature(task.raw);
            if (!zoneFeature || !zoneFeature.geometry) return null;
            return {
                type: 'Feature',
                geometry: zoneFeature.geometry,
                properties: Object.assign({}, task.properties, {
                    id: task.alertId,
                    color: task.color
                })
            };
        }));
        for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
                rendered.push(result.value);
            }
        }
    }

    lastStats.rendered_watch_zones = rendered.length;

    const renderedKey = rendered.map(f => `${f.properties?.id}|${f.properties?.event}|${f.properties?.color}`).sort().join('\n');
    if (renderedKey !== _lastRenderedKey) {
        _lastRenderedKey = renderedKey;
        _upsert_layers(turf.featureCollection(rendered));
    }
    _record_perf(performance.now() - start, rendered.length);
    _updateInProgress = false;
}

function get_stats() {
    return Object.assign({}, lastStats);
}

function zoom_to_first_watch() {
    const source = map.getSource(WATCH_SOURCE_ID);
    if (!source || !source._data || !source._data.features || source._data.features.length === 0) return false;
    const first = source._data.features[0];
    if (!first || !first.geometry) return false;
    try {
        const bbox = turf.bbox(first.geometry);
        map.fitBounds(bbox, { padding: 40, maxZoom: 8, duration: 800 });
        return true;
    } catch (_) {
        return false;
    }
}

module.exports = {
    update_from_alerts_data,
    get_stats,
    zoom_to_first_watch,
    is_overlay_event: _is_overlay_event
};

