const get_polygon_colors = require('./colors/polygon_colors');
const set_layer_order = require('../core/map/setLayerOrder');
const click_listener = require('./click_listener');
const filter_alerts = require('./filter_alerts');
const map = require('../core/map/map');
const AlertUpdater = require('./updater/AlertUpdater');
const turf = require('@turf/turf');
const watch_overlay = require('./watch_overlay');

const BLINK_INTERVAL_MS = 500;
const WATCH_FILL_OPACITY = 0.15;

let _blinkIntervalId = null;
let _blinkPhase = false;
let _lastAlertsGeojson = null;
let _perfPaintUpdates = 0;
let _lastWatchDebugStats = {
    watch_raw_geometry: 0,
    watch_after_filter: 0,
    total_after_filter: 0
};

// Per-alert blink tracking: alertId -> expiry timestamp (ms)
let _blinkingAlerts = new Map();
let _blinkExpiryTimer = null;

function _deep_clone(data) {
    if (typeof structuredClone === 'function') return structuredClone(data);
    return JSON.parse(JSON.stringify(data));
}

function _record_perf(metricPrefix, durationMs, extra) {
    if (typeof window === 'undefined' || !window.stormTrackData) return;
    const perf = window.stormTrackData.perf = window.stormTrackData.perf || {};
    const callsKey = `${metricPrefix}Calls`;
    const lastKey = `${metricPrefix}LastMs`;
    perf[callsKey] = (perf[callsKey] || 0) + 1;
    perf[lastKey] = durationMs;
    if (extra && typeof extra === 'object') {
        Object.assign(perf, extra);
    }
}

function _is_watch_event(event) {
    return !!event && (event.endsWith('Watch') || event.includes(' Watch'));
}

function _watch_key(f) {
    const p = f?.properties || {};
    return f.id || p.id || `${p.event || ''}|${p.sent || ''}|${p.headline || ''}`;
}

function _parse_zone_url(url) {
    if (!url || typeof url !== 'string') return null;
    const clean = url.split('?')[0].replace(/\/+$/, '');
    if (clean.includes('/zones/forecast/')) {
        return { type: 'forecast', id: clean.substring(clean.lastIndexOf('/') + 1) };
    }
    if (clean.includes('/zones/county/')) {
        return { type: 'county', id: clean.substring(clean.lastIndexOf('/') + 1) };
    }
    if (clean.includes('/zones/fire/')) {
        return { type: 'fire', id: clean.substring(clean.lastIndexOf('/') + 1) };
    }
    return null;
}

function _expand_null_geometry_watches(alerts_data) {
    const features = alerts_data?.features || [];
    if (features.length === 0) return alerts_data;

    const zoneDicts = {
        forecast: (typeof forecast_zones !== 'undefined' ? forecast_zones : ((typeof window !== 'undefined' && window.forecast_zones) ? window.forecast_zones : {})),
        county: (typeof county_zones !== 'undefined' ? county_zones : ((typeof window !== 'undefined' && window.county_zones) ? window.county_zones : {})),
        fire: (typeof fire_zones !== 'undefined' ? fire_zones : ((typeof window !== 'undefined' && window.fire_zones) ? window.fire_zones : {}))
    };

    const hasAnyZones =
        Object.keys(zoneDicts.forecast).length > 0 ||
        Object.keys(zoneDicts.county).length > 0 ||
        Object.keys(zoneDicts.fire).length > 0;
    if (!hasAnyZones) return alerts_data;

    const existingGeometryWatchKeys = new Set(
        features
            .filter((f) => _is_watch_event(f?.properties?.event || '') && f?.geometry)
            .map(_watch_key)
    );

    const expanded = [];
    for (const f of features) {
        const event = f?.properties?.event || '';
        const isWatch = _is_watch_event(event);
        const hasGeometry = !!f?.geometry;

        if (!isWatch) {
            expanded.push(f);
            continue;
        }

        if (hasGeometry) {
            expanded.push(f);
            continue;
        }

        const key = _watch_key(f);
        if (existingGeometryWatchKeys.has(key)) {
            continue;
        }

        const affectedZones = f?.properties?.affectedZones || [];
        let expandedThisWatch = false;
        for (const zoneUrl of affectedZones) {
            const parsed = _parse_zone_url(zoneUrl);
            if (!parsed) continue;
            const zoneFeature = zoneDicts[parsed.type]?.[parsed.id];
            if (!zoneFeature || !zoneFeature.geometry) continue;

            const newProps = Object.assign({}, f.properties, {
                zone_type: parsed.type,
                affectedZones: [parsed.id]
            });
            expanded.push(turf.feature(zoneFeature.geometry, newProps));
            expandedThisWatch = true;
        }

        if (!expandedThisWatch) {
            expanded.push(f);
        }
    }

    alerts_data.features = expanded;
    return alerts_data;
}

function _get_normal_line_color_expr() {
    return [
        'case',
        ['==', ['get', 'type'], 'outline'],
        ['get', 'color'],
        ['==', ['get', 'type'], 'border'],
        'black',
        'rgba(0, 0, 0, 0)'
    ];
}

function _get_outline_line_width(scale) {
    return [
        'case',
        ['>=', ['index-of', 'Watch', ['get', 'event']], 0],
        2 * scale,
        3 * scale
    ];
}

function _get_alert_fill_opacity_expr(baseOpacity) {
    return [
        'case',
        ['>=', ['index-of', 'Watch', ['get', 'event']], 0],
        WATCH_FILL_OPACITY,
        baseOpacity
    ];
}

function _get_blink_color() {
    return (window.stormTrackData && window.stormTrackData.alertBlinkColor) || '#000000';
}

function _get_blink_duration() {
    return ((window.stormTrackData && window.stormTrackData.alertBlinkDuration) || 30) * 1000;
}

function _is_live_mode_blink_suppressed() {
    return !!(typeof window !== 'undefined' && window.stormTrackData && window.stormTrackData.liveModeActive);
}

function _stop_blink_interval() {
    if (_blinkIntervalId) {
        clearInterval(_blinkIntervalId);
        _blinkIntervalId = null;
    }
    if (map.getLayer('alertsBlinkLayer')) {
        map.setLayoutProperty('alertsBlinkLayer', 'visibility', 'none');
    }
}

function _purge_expired_blinks() {
    if (_blinkingAlerts.size === 0) return false;
    const now = Date.now();
    let changed = false;
    for (const [id, expiry] of _blinkingAlerts) {
        if (now >= expiry) {
            _blinkingAlerts.delete(id);
            changed = true;
        }
    }
    return changed;
}

function _refresh_blink_state() {
    if (_is_live_mode_blink_suppressed()) {
        _blinkingAlerts.clear();
        _stop_blink_interval();
        if (_blinkExpiryTimer) { clearTimeout(_blinkExpiryTimer); _blinkExpiryTimer = null; }
        if (_lastAlertsGeojson && _lastAlertsGeojson.features) {
            const source = map.getSource('alertsSource');
            if (source) {
                const data = _deep_clone(_lastAlertsGeojson);
                data.features.forEach((f) => { f.properties.blinking = false; });
                _lastAlertsGeojson = data;
                source.setData(data);
            }
        }
        return;
    }

    _purge_expired_blinks();

    if (_blinkingAlerts.size === 0) {
        _stop_blink_interval();
        if (_blinkExpiryTimer) { clearTimeout(_blinkExpiryTimer); _blinkExpiryTimer = null; }
        // Update source to clear all blinking flags
        if (_lastAlertsGeojson && _lastAlertsGeojson.features) {
            const source = map.getSource('alertsSource');
            if (source) {
                const data = _deep_clone(_lastAlertsGeojson);
                data.features.forEach((f) => { f.properties.blinking = false; });
                _lastAlertsGeojson = data;
                source.setData(data);
            }
        }
        return;
    }

    // Update blinking flags in source based on current tracking map
    if (_lastAlertsGeojson && _lastAlertsGeojson.features) {
        const source = map.getSource('alertsSource');
        if (source) {
            const data = _deep_clone(_lastAlertsGeojson);
            data.features.forEach((f) => {
                const fid = f.id || f.properties?.id;
                f.properties.blinking = _blinkingAlerts.has(fid);
            });
            _lastAlertsGeojson = data;
            source.setData(data);
        }
    }

    _ensure_blink_interval();
    _schedule_next_expiry_check();
}

function _schedule_next_expiry_check() {
    if (_blinkExpiryTimer) { clearTimeout(_blinkExpiryTimer); _blinkExpiryTimer = null; }
    if (_blinkingAlerts.size === 0) return;

    let earliest = Infinity;
    for (const expiry of _blinkingAlerts.values()) {
        if (expiry < earliest) earliest = expiry;
    }
    const delay = Math.max(100, earliest - Date.now());
    _blinkExpiryTimer = setTimeout(_refresh_blink_state, delay);
}

function _ensure_blink_interval() {
    if (_blinkIntervalId) return;
    if (_is_live_mode_blink_suppressed()) return;
    if (!map.getLayer('alertsBlinkLayer')) return;
    _blinkPhase = false;
    map.setPaintProperty('alertsBlinkLayer', 'line-color', _get_blink_color());
    map.setLayoutProperty('alertsBlinkLayer', 'visibility', 'visible');
    _blinkIntervalId = setInterval(() => {
        _blinkPhase = !_blinkPhase;
        if (map.getLayer('alertsBlinkLayer')) {
            map.setLayoutProperty('alertsBlinkLayer', 'visibility', _blinkPhase ? 'none' : 'visible');
        }
    }, BLINK_INTERVAL_MS);
}

function set_blinking_for_alert(alertId) {
    if (_is_live_mode_blink_suppressed()) {
        _blinkingAlerts.clear();
        clear_blinking_focus();
        return;
    }
    if (!_lastAlertsGeojson || !_lastAlertsGeojson.features) return;
    const source = map.getSource('alertsSource');
    if (!source) return;
    const data = _deep_clone(_lastAlertsGeojson);
    data.features.forEach((f) => {
        const fid = f.id || f.properties?.id;
        f.properties.blinking = (fid === alertId);
    });
    source.setData(data);
    _ensure_blink_interval();
}

function clear_blinking_focus() {
    if (!_lastAlertsGeojson || !_lastAlertsGeojson.features) {
        _stop_blink_interval();
        return;
    }
    const source = map.getSource('alertsSource');
    if (source) {
        const data = _deep_clone(_lastAlertsGeojson);
        data.features.forEach((f) => { f.properties.blinking = false; });
        source.setData(data);
    }
    _stop_blink_interval();
}

function _add_alert_layers(geojson) {
    if (map.getSource('alertsSource')) {
        map.getSource('alertsSource').setData(geojson);
    } else {
        const fillOpacity = (window.stormTrackData && window.stormTrackData.alertFillOpacity != null) ? window.stormTrackData.alertFillOpacity : 0.1;
        const bScale = (window.stormTrackData && window.stormTrackData.alertBorderScale != null) ? window.stormTrackData.alertBorderScale : 0.75;
        map.addSource(`alertsSource`, {
            type: 'geojson',
            data: geojson,
        })
        map.addLayer({
            'id': 'alertsBlinkLayer',
            'type': 'line',
            'source': 'alertsSource',
            'filter': ['all', ['==', ['get', 'blinking'], true], ['==', ['get', 'type'], 'outline']],
            'layout': { 'visibility': 'none' },
            'paint': {
                'line-color': _get_blink_color(),
                'line-width': _get_outline_line_width(bScale)
            }
        });
        map.addLayer({
            'id': `alertsLayer`,
            'type': 'line',
            'source': `alertsSource`,
            'filter': ['!=', ['get', '_dashed'], true],
            'paint': {
                'line-color': _get_normal_line_color_expr(),
                'line-width': [
                    'case',
                    ['==', ['get', 'type'], 'outline'],
                    [
                        'case',
                        ['>=', ['index-of', 'Watch', ['get', 'event']], 0],
                        2 * bScale,
                        3 * bScale
                    ],
                    ['==', ['get', 'type'], 'border'],
                    [
                        'case',
                        ['>=', ['index-of', 'Watch', ['get', 'event']], 0],
                        4 * bScale,
                        7 * bScale
                    ],
                    0
                ]
            }
        });
        map.addLayer({
            'id': 'alertsDashedLayer',
            'type': 'line',
            'source': 'alertsSource',
            'filter': ['all', ['==', ['get', '_dashed'], true], ['==', ['get', 'type'], 'outline']],
            'layout': { 'line-cap': 'butt' },
            'paint': {
                'line-color': ['get', 'color'],
                'line-width': 3 * bScale,
                'line-dasharray': [3, 2]
            }
        });
        map.addLayer({
            'id': `alertsLayerFill`,
            'type': 'fill',
            'source': `alertsSource`,
            'filter': ['!=', ['get', '_dashed'], true],
            paint: {
                'fill-color': ['get', 'color'],
                'fill-opacity': _get_alert_fill_opacity_expr(fillOpacity)
            }
        });

        map.on('mouseover', `alertsLayerFill`, function(e) {
            map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseout', `alertsLayerFill`, function(e) {
            map.getCanvas().style.cursor = '';
        });

        map.on('click', `alertsLayerFill`, click_listener);
    }
}

function _sort_by_priority(data) {
    data.features = data.features.sort((a, b) => b.properties.priority - a.properties.priority);
    return data;
}

function plot_alerts(alerts_data, options) {
    const start = performance.now();
    options = options || {};
    const new_alert_ids = options.new_alert_ids || new Set();
    const new_alert_features = options.new_alert_features || [];
    const focusNewAlerts = options.focus_new_alerts || false;

    if (window.stormTrackData && window.stormTrackData.testAlertFeatures && window.stormTrackData.testAlertFeatures.length > 0) {
        alerts_data = JSON.parse(JSON.stringify(alerts_data));
        alerts_data.features = (alerts_data.features || []).concat(window.stormTrackData.testAlertFeatures);
    }

    // Purge expired blinks but do NOT stop the interval -- existing blinkers keep going
    _purge_expired_blinks();

    alerts_data = _expand_null_geometry_watches(alerts_data);
    const watch_raw_geometry = (alerts_data.features || []).filter((f) => _is_watch_event(f?.properties?.event || '') && !!f?.geometry).length;

    for (var item in alerts_data.features) {
        var gpc = get_polygon_colors(alerts_data.features[item].properties.event);
        alerts_data.features[item].properties.color = gpc.color;
        alerts_data.features[item].properties.priority = parseInt(gpc.priority);
    }
    alerts_data = _sort_by_priority(alerts_data);
    alerts_data = filter_alerts(alerts_data);
    alerts_data.features = (alerts_data.features || []).filter((f) => {
        const event = f?.properties?.event || '';
        if (f?.properties?._isTestAlert) return true;
        if (event === 'Special Weather Statement' && f?.geometry) return true;
        return !(watch_overlay.is_overlay_event && watch_overlay.is_overlay_event(event));
    });
    const watch_after_filter = (alerts_data.features || []).filter((f) => _is_watch_event(f?.properties?.event || '') && !!f?.geometry).length;
    const total_after_filter = (alerts_data.features || []).length;
    _lastWatchDebugStats = {
        watch_raw_geometry,
        watch_after_filter,
        total_after_filter
    };

    const blinkEnabled = !_is_live_mode_blink_suppressed() && (!window.stormTrackData || window.stormTrackData.alertBlinkEnabled !== false);
    const blinkDuration = _get_blink_duration();
    const now = Date.now();

    if (!blinkEnabled) {
        _blinkingAlerts.clear();
    }

    // Register new blinkers into the per-alert tracking map
    if (blinkEnabled && !focusNewAlerts) {
        for (const id of new_alert_ids) {
            if (!_blinkingAlerts.has(id)) {
                _blinkingAlerts.set(id, now + blinkDuration);
            }
        }
    }

    // Register test alert blinkers
    if (blinkEnabled) {
        for (const feature of alerts_data.features) {
            if (!(feature.properties?._isTestAlert && feature.properties?.blinking)) continue;
            const tid = feature.id || feature.properties?.id;
            if (tid && !_blinkingAlerts.has(tid)) {
                _blinkingAlerts.set(tid, now + blinkDuration);
            }
        }
    }

    const duplicate_features = [];
    for (const feature of alerts_data.features) {
        const alertId = feature.id || feature.properties?.id;
        const blinking = _blinkingAlerts.has(alertId);
        const baseProps = Object.assign({}, feature.properties);
        const isDashed = !!feature.properties?._dashed;

        duplicate_features.push(Object.assign({}, feature, {
            properties: Object.assign({}, baseProps, {
                type: 'border',
                blinking,
                _dashed: isDashed
            })
        }));
        duplicate_features.push(Object.assign({}, feature, {
            properties: Object.assign({}, baseProps, {
                type: 'outline',
                blinking,
                _dashed: isDashed
            })
        }));
    }
    alerts_data.features = duplicate_features;
    _lastAlertsGeojson = _deep_clone(alerts_data);

    _add_alert_layers(alerts_data);

    // Start or maintain blink interval if anything is blinking
    if (_blinkingAlerts.size > 0 && map.getLayer('alertsBlinkLayer')) {
        _ensure_blink_interval();
        _schedule_next_expiry_check();
    } else {
        _stop_blink_interval();
    }

    if (options.on_new_alerts && new_alert_features.length > 0) {
        options.on_new_alerts(new_alert_features);
    }

    set_layer_order();

    if (!window.location.hash.includes('dev')) {
        if (window.stormTrackData.current_AlertUpdater == undefined) {
            const current_AlertUpdater = new AlertUpdater();
            current_AlertUpdater.enable();
            window.stormTrackData.current_AlertUpdater = current_AlertUpdater;
        }
    }
    _record_perf('plotAlerts', performance.now() - start, { plotAlertsFeatureCount: alerts_data.features.length });
}

module.exports = plot_alerts;
module.exports.set_blinking_for_alert = set_blinking_for_alert;
module.exports.clear_blinking_focus = clear_blinking_focus;
module.exports.get_watch_debug_stats = function () {
    return Object.assign({}, _lastWatchDebugStats);
};
module.exports.zoom_to_first_watch = function () {
    if (!_lastAlertsGeojson || !_lastAlertsGeojson.features || !map) return false;
    const firstWatch = _lastAlertsGeojson.features.find((f) => {
        const event = f?.properties?.event || '';
        const type = f?.properties?.type || '';
        return _is_watch_event(event) && !!f?.geometry && type === 'outline';
    }) || _lastAlertsGeojson.features.find((f) => {
        const event = f?.properties?.event || '';
        return _is_watch_event(event) && !!f?.geometry;
    });
    if (!firstWatch || !firstWatch.geometry) return false;
    try {
        const bbox = turf.bbox(firstWatch.geometry);
        map.fitBounds(bbox, { padding: 40, maxZoom: 8, duration: 800 });
        return true;
    } catch (_) {
        return false;
    }
};
