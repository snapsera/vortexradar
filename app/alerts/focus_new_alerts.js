/**
 * When Focus New Alerts is enabled, fly to new alerts and show a floating info panel.
 * Only focuses on NEW alerts that are turned ON in Alerts Display settings.
 * 30 seconds per alert, panel closes when done.
 */
const map = require('../core/map/map');
const turf = require('@turf/turf');
const chroma = require('chroma-js');
const get_polygon_colors = require('./colors/polygon_colors');
const alert_helpers = require('./alert_helpers');
const station_markers = require('../radar/station_markers/station_markers');
const nexrad_locations = require('../radar/libnexrad/nexrad_locations').NEXRAD_LOCATIONS;
const filter_alerts = require('./filter_alerts');

const FOCUS_DURATION_MS = 30000;
const FADE_DURATION_MS = 600;
const RADAR_RANGE_KM = 230;

let _focusTimeoutId = null;
let _alertQueue = [];

function _get_severe_alerts_enabled() {
    const data = window.stormTrackData?.alerts_data;
    if (!data || !data.features) return [];
    const seen = new Set();
    return data.features.filter((f) => {
        const id = f.id || f?.properties?.id;
        if (!id || seen.has(id) || !f.geometry) return false;
        seen.add(id);
        return alert_helpers.is_severe_weather_alert(f?.properties?.event) &&
            filter_alerts.should_show_alert_feature(f);
    });
}

function _radar_has_severe_in_coverage(stationId) {
    const loc = nexrad_locations[stationId];
    if (!loc) return false;
    const rangeCircle = turf.circle([loc.lon, loc.lat], RADAR_RANGE_KM, {
        steps: 32,
        units: 'kilometers'
    });
    const severeAlerts = _get_severe_alerts_enabled();
    for (const alert of severeAlerts) {
        try {
            const alertFeature = turf.feature(alert.geometry);
            if (turf.booleanIntersects(alertFeature, rangeCircle)) return true;
        } catch (_) {}
    }
    return false;
}

function _get_station_with_severe_alert(preferNearFeature) {
    const stationsWithSevere = [];
    for (const [stationId, loc] of Object.entries(nexrad_locations)) {
        if (loc.type !== 'WSR-88D') continue;
        if (_radar_has_severe_in_coverage(stationId)) {
            stationsWithSevere.push({ stationId, loc });
        }
    }
    if (stationsWithSevere.length === 0) return null;
    if (preferNearFeature && preferNearFeature.geometry) {
        const geom = preferNearFeature.geometry;
        const best = alert_helpers.get_best_wsr88d_radar(geom);
        if (best && stationsWithSevere.some((s) => s.stationId === best)) {
            return best;
        }
        try {
            const centroid = turf.centroid(turf.feature(geom));
            const [lng, lat] = centroid.geometry.coordinates;
            let closest = null;
            let minDist = Infinity;
            for (const { stationId, loc } of stationsWithSevere) {
                const dist = turf.distance(
                    turf.point([lng, lat]),
                    turf.point([loc.lon, loc.lat]),
                    { units: 'kilometers' }
                );
                if (dist < minDist) {
                    minDist = dist;
                    closest = stationId;
                }
            }
            return closest;
        } catch (_) {}
    }
    return stationsWithSevere[0].stationId;
}

function _set_title(text, isNew) {
    const title = $('.focusNewAlertsTitle');
    if (!title.length) return;
    title.text(text);
    title.toggleClass('focusNewAlertsTitle-new', !!isNew);
}

function _get_station_for_alert(feature) {
    const geom = feature?.geometry;
    if (!geom) return null;
    try {
        const centroid = turf.centroid(turf.feature(geom));
        const [lng, lat] = centroid.geometry.coordinates;
        return alert_helpers.get_best_wsr88d_radar(geom, lng, lat);
    } catch (_) {
        return null;
    }
}

function _select_radar_for_alert(feature) {
    const station = _get_station_for_alert(feature);
    if (!station || !nexrad_locations[station]) return;
    const loc = nexrad_locations[station];
    const stationType = loc.type || 'WSR-88D';
    if (station_markers.selectStation) {
        station_markers.selectStation(station, stationType);
    }
}

function _fly_to_alerts(features) {
    const geoms = features.map((f) => f.geometry).filter(Boolean);
    if (geoms.length === 0) return;
    try {
        const collection = turf.featureCollection(geoms.map((g) => turf.feature(g)));
        const bbox = turf.bbox(collection);
        map.fitBounds(bbox, { padding: 40, maxZoom: 8, duration: 800 });
    } catch (_) {}
}

function _zoom_to_radar_range(features) {
    let station = window.stormTrackData?.currentStation;
    if (!station && features && features.length > 0) {
        station = _get_station_for_alert(features[0]);
    }
    const loc = station && nexrad_locations[station];
    if (!loc) return;
    try {
        const rangeCircle = turf.circle([loc.lon, loc.lat], RADAR_RANGE_KM, {
            steps: 64,
            units: 'kilometers'
        });
        const bbox = turf.bbox(rangeCircle);
        map.fitBounds(bbox, { padding: 40, duration: 800 });
    } catch (_) {}
}

function _build_panel_html(feature) {
    const p = feature.properties || {};
    const event = p.event || 'Alert';
    const color = get_polygon_colors(event).color;
    const hexColor = chroma(color).hex();
    const textColor = chroma(color).luminance() > 0.4 ? 'black' : 'white';
    const body = alert_helpers.build_full_alert_body(p);
    return `
        <div class="focusNewAlertCard" style="border-left: 4px solid ${hexColor}; --alert-color: ${hexColor}">
            <div class="focusNewAlertHeader" style="background: ${hexColor}; color: ${textColor}">${event}</div>
            <div class="focusNewAlertBody">${body}</div>
        </div>
    `;
}

function _schedule_focus_end(currentFeature) {
    if (_focusTimeoutId) clearTimeout(_focusTimeoutId);
    _focusTimeoutId = setTimeout(() => {
        _focusTimeoutId = null;
        const panel = $('#focusNewAlertsPanel');
        panel.addClass('focusNewAlertsPanel-fading');
        setTimeout(() => {
            panel.removeClass('focusNewAlertsPanel-fading');
            if (_alertQueue.length > 0) {
                _show_next();
            } else {
                panel.removeClass('focusNewAlertsPanel-visible');
                let stationToSelect = _get_station_with_severe_alert(currentFeature);
                if (!stationToSelect && currentFeature) {
                    stationToSelect = _get_station_for_alert(currentFeature);
                }
                if (stationToSelect && nexrad_locations[stationToSelect] && station_markers.selectStation) {
                    const loc = nexrad_locations[stationToSelect];
                    station_markers.selectStation(stationToSelect, loc.type || 'WSR-88D');
                }
                _zoom_to_radar_range(currentFeature ? [currentFeature] : null);
                const plot_alerts = require('./plot_alerts');
                if (plot_alerts.clear_blinking_focus) {
                    plot_alerts.clear_blinking_focus();
                }
            }
        }, FADE_DURATION_MS);
    }, FOCUS_DURATION_MS);
}

function _get_alert_id(feature) {
    return feature.id || feature.properties?.id || null;
}

function _show_next() {
    if (_alertQueue.length === 0) return;

    const feature = _alertQueue[0];
    _alertQueue = _alertQueue.slice(1);

    _set_title('New Alert', true);

    _select_radar_for_alert(feature);
    _fly_to_alerts([feature]);

    const plot_alerts = require('./plot_alerts');
    const alertId = _get_alert_id(feature);
    if (alertId && plot_alerts.set_blinking_for_alert) {
        plot_alerts.set_blinking_for_alert(alertId);
    }

    const panel = $('#focusNewAlertsPanel');
    if (!panel.length) return;

    panel.removeClass('focusNewAlertsPanel-fading');
    panel.find('.focusNewAlertsContent').html(_build_panel_html(feature));
    panel.addClass('focusNewAlertsPanel-visible');
    _schedule_focus_end(feature);
}

function focus_on_new_alerts(features) {
    if (!features || features.length === 0) return;

    const enabled = features.filter((f) => filter_alerts.should_show_alert_feature(f));
    if (enabled.length === 0) return;

    const wasEmpty = _alertQueue.length === 0;
    _alertQueue = _alertQueue.concat(enabled);

    if (wasEmpty) {
        _show_next();
    }
}

function hide_focus_panel() {
    if (_focusTimeoutId) {
        clearTimeout(_focusTimeoutId);
        _focusTimeoutId = null;
    }
    _alertQueue = [];
    const plot_alerts = require('./plot_alerts');
    if (plot_alerts.clear_blinking_focus) {
        plot_alerts.clear_blinking_focus();
    }
    $('#focusNewAlertsPanel').removeClass('focusNewAlertsPanel-visible focusNewAlertsPanel-fading');
    requestAnimationFrame(() => {
        setTimeout(() => map.resize(), 50);
    });
}

function init() {
    const panel = $('#focusNewAlertsPanel');
    if (panel.length) {
        panel.find('.focusNewAlertsClose').on('click', hide_focus_panel);
    }
}

module.exports = {
    focus_on_new_alerts,
    hide_focus_panel,
    init
};
