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
const WATCH_FILL_OPACITY = 0.15;
const ZONE_FETCH_CONCURRENCY = 8;
const MISSING_ALERT_GRACE_MS = 45000;

const zoneCache = new Map();
const overlayFeatureCacheByAlertId = new Map();
let _lastRenderedKey = '';
let _updateInProgress = false;
let _pendingAlertsData = null;
let _lastRenderedFeatureCollection = turf.featureCollection([]);
let _layerGuardStarted = false;
let lastStats = {
    active_watch_alerts: 0,
    rendered_watch_zones: 0,
    zone_fetch_errors: 0,
    layer_rebuilds: 0
};

function _is_local_dev_mode() {
    if (typeof window === 'undefined' || !window.location) return false;
    const host = window.location.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function _dev_log(...args) {
    if (!_is_local_dev_mode()) return;
    console.debug('[watch_overlay]', ...args);
}

function _record_perf(durationMs, renderedCount) {
    if (typeof window === 'undefined' || !window.stormTrackData) return;
    const perf = window.stormTrackData.perf = window.stormTrackData.perf || {};
    perf.watchOverlayCalls = (perf.watchOverlayCalls || 0) + 1;
    perf.watchOverlayLastMs = durationMs;
    perf.watchOverlayRendered = renderedCount;
}

function _get_alert_id(feature) {
    return feature?.id || feature?.properties?.id || null;
}

function _parse_expiry_ms(props) {
    const expiresRaw = props?.expires || props?.ends || null;
    if (!expiresRaw) return null;
    const ms = Date.parse(expiresRaw);
    return Number.isFinite(ms) ? ms : null;
}

function _prune_expired_cache(nowMs) {
    for (const [alertId, entry] of overlayFeatureCacheByAlertId.entries()) {
        if (entry.expiresMs != null && nowMs >= entry.expiresMs) {
            overlayFeatureCacheByAlertId.delete(alertId);
        }
    }
}

function _flatten_cache_features() {
    const out = [];
    for (const entry of overlayFeatureCacheByAlertId.values()) {
        if (!entry || !Array.isArray(entry.features)) continue;
        out.push(...entry.features);
    }
    return out;
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
        if (map.getLayer(WATCH_FILL_ID)) {
            map.setPaintProperty(WATCH_FILL_ID, 'fill-opacity', WATCH_FILL_OPACITY);
        }
        if (map.getLayer(WATCH_LINE_BORDER_ID)) {
            map.removeLayer(WATCH_LINE_BORDER_ID);
        }
        if (map.getLayer(WATCH_LINE_ID)) {
            map.removeLayer(WATCH_LINE_ID);
        }
        return;
    }

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
            'fill-opacity': WATCH_FILL_OPACITY
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

function _ensure_overlay_layers_present() {
    if (!map || !map.loaded || !map.loaded()) return;
    if (_updateInProgress) return;
    if (!_lastRenderedFeatureCollection || !_lastRenderedFeatureCollection.features) return;
    if (_lastRenderedFeatureCollection.features.length === 0) return;

    const missing = !map.getSource(WATCH_SOURCE_ID) ||
        !map.getLayer(WATCH_FILL_ID);
    if (!missing) return;

    lastStats.layer_rebuilds += 1;
    _dev_log('Layer guard rebuilt watch overlay source/layers from cached render.', {
        rebuildCount: lastStats.layer_rebuilds,
        renderedFeatures: _lastRenderedFeatureCollection.features.length
    });
    _upsert_layers(_lastRenderedFeatureCollection);
}

function _start_layer_guard() {
    if (_layerGuardStarted) return;
    _layerGuardStarted = true;
    setInterval(_ensure_overlay_layers_present, 2000);
}

async function update_from_alerts_data(alerts_data) {
    if (_updateInProgress) {
        _pendingAlertsData = alerts_data;
        return;
    }
    _updateInProgress = true;
    const start = performance.now();
    try {
        const features = alerts_data?.features || [];
        const currentPayloadIds = new Set(
            features
                .map((f) => _get_alert_id(f))
                .filter(Boolean)
        );
        const activeWatchAlerts = features.filter((f) => {
            const event = f?.properties?.event || '';
            if (!_is_overlay_event(event)) return false;
            if (event === 'Special Weather Statement') {
                if (f?.geometry) return false;
                return alerts_display_state.get_alert_type_enabled('Special Weather Statement (County)');
            }
            return alerts_display_state.get_alert_type_enabled(event);
        });
        const activeOverlayIds = new Set(
            activeWatchAlerts
                .map((f) => _get_alert_id(f))
                .filter(Boolean)
        );
        lastStats.active_watch_alerts = activeWatchAlerts.length;
        lastStats.zone_fetch_errors = 0;

        const rendered = [];
        const renderedByAlertId = new Map();
        const dedupe = new Set();
        const zoneFetchQueue = [];
        const fallbackAlerts = [];
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
                renderedByAlertId.set(alertId, (renderedByAlertId.get(alertId) || 0) + 1);
            } else if (alertFeature.geometry) {
                fallbackAlerts.push({
                    alertId,
                    geometry: alertFeature.geometry,
                    properties: p,
                    color
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
                    const aid = result.value.properties?.id;
                    if (aid) renderedByAlertId.set(aid, (renderedByAlertId.get(aid) || 0) + 1);
                }
            }
        }

        // If zone fetch/expansion produced nothing for an alert that already had geometry,
        // keep it visible using the native alert geometry.
        for (const fallback of fallbackAlerts) {
            if ((renderedByAlertId.get(fallback.alertId) || 0) > 0) continue;
            rendered.push({
                type: 'Feature',
                geometry: fallback.geometry,
                properties: Object.assign({}, fallback.properties, {
                    id: fallback.alertId,
                    color: fallback.color
                })
            });
            renderedByAlertId.set(fallback.alertId, (renderedByAlertId.get(fallback.alertId) || 0) + 1);
        }

        // Update persistent per-alert cache so each alert remains visible until
        // that alert updates or expires, instead of full-collection replacement.
        const groupedRendered = new Map();
        for (const feature of rendered) {
            const alertId = feature?.properties?.id;
            if (!alertId) continue;
            if (!groupedRendered.has(alertId)) groupedRendered.set(alertId, []);
            groupedRendered.get(alertId).push(feature);
        }
        const nowMs = Date.now();
        for (const [alertId, alertFeatures] of groupedRendered.entries()) {
            if (!alertFeatures.length) continue;
            const baseProps = alertFeatures[0].properties || {};
            overlayFeatureCacheByAlertId.set(alertId, {
                features: alertFeatures,
                expiresMs: _parse_expiry_ms(baseProps),
                event: baseProps.event || null,
                lastSeenMs: nowMs,
                missingSinceMs: null
            });
        }

        // If an alert id exists in current payload but is no longer an enabled
        // overlay event, remove it immediately from cache (user toggle changes).
        for (const alertId of currentPayloadIds) {
            if (activeOverlayIds.has(alertId)) continue;
            overlayFeatureCacheByAlertId.delete(alertId);
        }

        // If an id vanishes from payload entirely, keep it briefly to survive
        // transient feed gaps, then remove to prevent long-lived duplicates.
        for (const [cachedAlertId, cachedEntry] of overlayFeatureCacheByAlertId.entries()) {
            if (activeOverlayIds.has(cachedAlertId)) {
                if (cachedEntry) cachedEntry.missingSinceMs = null;
                continue;
            }
            if (!currentPayloadIds.has(cachedAlertId)) {
                if (!cachedEntry) {
                    overlayFeatureCacheByAlertId.delete(cachedAlertId);
                    continue;
                }
                if (currentPayloadIds.size === 0) {
                    // Empty payload snapshots are typically transient/API issues.
                    continue;
                }
                if (!cachedEntry.missingSinceMs) {
                    cachedEntry.missingSinceMs = nowMs;
                    continue;
                }
                if ((nowMs - cachedEntry.missingSinceMs) >= MISSING_ALERT_GRACE_MS) {
                    overlayFeatureCacheByAlertId.delete(cachedAlertId);
                }
            }
        }

        // Keep expiration-based pruning as a fallback safety net.
        _prune_expired_cache(nowMs);

        const persistentFeatures = _flatten_cache_features();
        lastStats.rendered_watch_zones = persistentFeatures.length;

        const renderedKey = persistentFeatures.map(f => `${f.properties?.id}|${f.properties?.event}|${f.properties?.color}`).sort().join('\n');
        const needsLayerRebuild = !map.getSource(WATCH_SOURCE_ID) ||
            !map.getLayer(WATCH_FILL_ID);
        if (needsLayerRebuild) {
            lastStats.layer_rebuilds += 1;
            _dev_log('Rebuilding watch overlay layers because source/layer was missing.', {
                rebuildCount: lastStats.layer_rebuilds,
                renderedFeatures: persistentFeatures.length
            });
        }
        if (renderedKey !== _lastRenderedKey || needsLayerRebuild) {
            _lastRenderedKey = renderedKey;
            _lastRenderedFeatureCollection = turf.featureCollection(persistentFeatures);
            _upsert_layers(_lastRenderedFeatureCollection);
        }
        _record_perf(performance.now() - start, persistentFeatures.length);
    } finally {
        _updateInProgress = false;
        if (_pendingAlertsData) {
            const pending = _pendingAlertsData;
            _pendingAlertsData = null;
            update_from_alerts_data(pending);
        }
    }
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

_start_layer_guard();

