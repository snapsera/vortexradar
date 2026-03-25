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
const { DateTime } = require('luxon');
const FIPS_POP = require('./fips_population.json');
const _STATE_TO_FIPS = {
    AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10', DC: '11',
    FL: '12', GA: '13', HI: '15', ID: '16', IL: '17', IN: '18', IA: '19', KS: '20', KY: '21',
    LA: '22', ME: '23', MD: '24', MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30',
    NE: '31', NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38', OH: '39',
    OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46', TN: '47', TX: '48', UT: '49',
    VT: '50', VA: '51', WA: '53', WV: '54', WI: '55', WY: '56', PR: '72'
};

const FOCUS_DURATION_MS = 30000;
const FADE_DURATION_MS = 600;
const RADAR_RANGE_KM = 230;

const _CONVECTIVE_EVENTS = [
    'Tornado Emergency', 'PDS Tornado Warning', 'Tornado Warning',
    'Severe Thunderstorm Warning', 'Severe Thunderstorm Watch', 'Tornado Watch'
];

const _FN_STATE_TO_TZ = {
    AL: 'America/Chicago', AR: 'America/Chicago', IL: 'America/Chicago', IA: 'America/Chicago',
    KS: 'America/Chicago', LA: 'America/Chicago', MN: 'America/Chicago', MS: 'America/Chicago',
    MO: 'America/Chicago', NE: 'America/Chicago', OK: 'America/Chicago', SD: 'America/Chicago',
    TN: 'America/Chicago', TX: 'America/Chicago', WI: 'America/Chicago', KY: 'America/Kentucky/Louisville',
    IN: 'America/Indiana/Indianapolis', ND: 'America/Chicago', SC: 'America/New_York',
    CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', GA: 'America/New_York',
    ME: 'America/New_York', MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit',
    NC: 'America/New_York', NH: 'America/New_York', NJ: 'America/New_York', NY: 'America/New_York',
    OH: 'America/New_York', PA: 'America/New_York', RI: 'America/New_York', VT: 'America/New_York',
    VA: 'America/New_York', WV: 'America/New_York', FL: 'America/New_York',
    AZ: 'America/Phoenix', CO: 'America/Denver', ID: 'America/Boise', MT: 'America/Denver',
    NM: 'America/Denver', UT: 'America/Denver', WY: 'America/Denver',
    CA: 'America/Los_Angeles', NV: 'America/Los_Angeles', OR: 'America/Los_Angeles', WA: 'America/Los_Angeles',
    AK: 'America/Anchorage', HI: 'Pacific/Honolulu',
    PR: 'America/Puerto_Rico', VI: 'America/Virgin', GU: 'Pacific/Guam', AS: 'Pacific/Pago_Pago',
    MP: 'Pacific/Guam'
};

function _fn_arr(val) {
    if (Array.isArray(val) && val[0]) return val[0];
    if (typeof val === 'string') return val;
    return null;
}

function _fn_get_state_from_ugc(properties) {
    const ugc = properties?.geocode?.UGC;
    if (ugc && (Array.isArray(ugc) ? ugc[0] : ugc)) {
        const code = Array.isArray(ugc) ? ugc[0] : ugc;
        return code.substring(0, 2).toUpperCase();
    }
    return null;
}

function _fn_format_expires(expires, properties) {
    if (!expires) return '';
    let dt = DateTime.fromISO(expires);
    if (!dt.isValid) return '';
    const state = properties ? _fn_get_state_from_ugc(properties) : null;
    const ianaTz = state && _FN_STATE_TO_TZ[state] ? _FN_STATE_TO_TZ[state] : null;
    if (ianaTz) dt = dt.setZone(ianaTz);
    const tzShort = dt.offsetNameShort || 'UTC';
    return dt.toFormat('h:mm a') + ' ' + tzShort;
}

function _fn_extract_impact(description) {
    if (!description) return null;
    const match = description.match(/IMPACT\.\.\.([\s\S]+?)(?=\n\n|$)/i);
    return match ? match[1].trim().replace(/\n/g, ' ') : null;
}

function _fn_extract_locations(description) {
    if (!description) return null;
    const match = description.match(/Locations impacted include\.\.\.\s*([\s\S]+?)(?:\n\n|$)/i);
    if (match) return match[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    return null;
}

let _focusTimeoutId = null;
let _alertQueue = [];
let _preFocusStation = null;
let _preFocusBounds = null;

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

function _save_pre_focus_state() {
    _preFocusStation = window.stormTrackData?.currentStation || null;
    try { _preFocusBounds = map.getBounds(); } catch (_) { _preFocusBounds = null; }
}

function _restore_pre_focus_state() {
    const plot_alerts = require('./plot_alerts');
    if (plot_alerts.clear_blinking_focus) {
        plot_alerts.clear_blinking_focus();
    }

    if (_preFocusStation && nexrad_locations[_preFocusStation] && station_markers.selectStation) {
        const loc = nexrad_locations[_preFocusStation];
        station_markers.selectStation(_preFocusStation, loc.type || 'WSR-88D');
    }

    if (_preFocusBounds) {
        try { map.fitBounds(_preFocusBounds, { padding: 0, duration: 800 }); } catch (_) {}
    }

    _preFocusStation = null;
    _preFocusBounds = null;
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

function _fn_countdown(expires) {
    if (!expires) return '';
    const expMs = new Date(expires).getTime();
    if (isNaN(expMs)) return '';
    const diff = expMs - Date.now();
    if (diff <= 0) return 'EXPIRED';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return 'EXPIRES IN ' + mins + ' MIN';
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return 'EXPIRES IN ' + hrs + ' HR ' + rem + ' MIN';
}

function _fn_get_population(properties) {
    var sameCodes = (properties.geocode && Array.isArray(properties.geocode.SAME))
        ? properties.geocode.SAME : [];
    var seen = {};
    var total = 0;
    for (var i = 0; i < sameCodes.length; i++) {
        var fips = sameCodes[i].substring(1);
        if (seen[fips]) continue;
        seen[fips] = true;
        if (FIPS_POP[fips]) total += FIPS_POP[fips];
    }
    if (total > 0) return total;

    // Fallback for products missing SAME but containing county UGC entries (e.g., TXC447).
    var ugcCodes = (properties.geocode && Array.isArray(properties.geocode.UGC))
        ? properties.geocode.UGC : [];
    for (var j = 0; j < ugcCodes.length; j++) {
        var match = /^([A-Z]{2})C(\d{3})$/i.exec(ugcCodes[j]);
        if (!match) continue;
        var stateAbbr = match[1].toUpperCase();
        var countyCode = match[2];
        var stateFips = _STATE_TO_FIPS[stateAbbr];
        if (!stateFips) continue;
        var countyFips = stateFips + countyCode;
        if (seen[countyFips]) continue;
        seen[countyFips] = true;
        if (FIPS_POP[countyFips]) total += FIPS_POP[countyFips];
    }
    return total;
}

function _build_panel_html(feature) {
    const p = feature.properties || {};
    const event = p.event || 'Alert';
    const hexColor = chroma(get_polygon_colors(event).color).hex();
    const params = p.parameters
        ? (typeof p.parameters === 'string' ? JSON.parse(p.parameters) : p.parameters)
        : {};
    const desc = (p.description || '').toUpperCase();
    const isConvective = _CONVECTIVE_EVENTS.includes(event);
    const isTor = event === 'Tornado Warning' || event === 'Tornado Emergency' || event === 'PDS Tornado Warning';

    const pills = [];

    if (isTor) {
        const torVal = _fn_arr(params.tornadoDetection);
        const torDisplay = torVal
            || (desc.includes('RADAR INDICATED') ? 'RADAR INDICATED' : null)
            || 'POSSIBLE';
        pills.push(torDisplay.toUpperCase());
    }

    const windVal = _fn_arr(params.maxWindGust);
    if (isConvective && windVal) pills.push(windVal);

    const hailVal = _fn_arr(params.maxHailSize);
    const hailNum = parseFloat(hailVal);
    if (isConvective && hailVal && !isNaN(hailNum) && hailNum > 0) {
        const hailStr = hailNum < 1
            ? '<' + hailVal.replace(/^0\./, '.') + '" HAIL'
            : hailNum.toFixed(2) + '" HAIL';
        pills.push(hailStr);
    }

    const damageThreat = _fn_arr(params.flashFloodDamageThreat) || _fn_arr(params.damageThreat);
    if (damageThreat) pills.push(damageThreat.toUpperCase());

    const impactedPop = _fn_get_population(p);
    pills.push(impactedPop > 0 ? impactedPop.toLocaleString() + ' IMPACTED' : 'UNKNOWN IMPACTED');

    const state = _fn_get_state_from_ugc(p);
    if (state) pills.push(state);

    const expires = p.expires || p.ends || _fn_arr(params.eventEndingTime);
    const countdownStr = _fn_countdown(expires);

    let whereStr = p.areaDesc || _fn_extract_locations(p.description) || '';

    let sourceStr = '';
    if (isTor) {
        sourceStr = _fn_arr(params.tornadoDetection)
            || (desc.includes('RADAR INDICATED') ? 'Radar.' : '')
            || 'Possible.';
    } else {
        sourceStr = _fn_arr(params.flashFloodDetection) || '';
        if (!sourceStr && (desc.includes('RADAR INDICATED') || desc.includes('RADAR-INDICATED'))) {
            sourceStr = 'Radar.';
        }
        if (!sourceStr && isConvective) {
            sourceStr = _fn_arr(params.windThreat) || _fn_arr(params.hailThreat) || '';
        }
    }

    let hazardStr = '';
    const impact = _fn_extract_impact(p.description);
    if (impact) {
        hazardStr = impact;
    } else if (p.instruction) {
        hazardStr = p.instruction;
    } else if (p.headline) {
        hazardStr = p.headline;
    }

    let html = `<div class="fnAlert" style="--fn-accent:${hexColor}">`;
    html += '<div class="fnAlertShine"></div>';
    html += '<button type="button" class="fnAlertClose"><i class="fa fa-xmark"></i></button>';
    html += '<div class="fnAlertBody">';

    html += `<div class="fnAlertEventName">${event}</div>`;

    if (countdownStr) {
        html += `<div class="fnAlertExpires">${countdownStr}</div>`;
    }

    if (pills.length) {
        html += '<div class="fnAlertPills">';
        for (const pill of pills) {
            html += `<span class="fnAlertPill">${pill}</span>`;
        }
        html += '</div>';
    }

    html += '<div class="fnAlertDivider"></div>';
    html += '<div class="fnAlertRows">';

    if (whereStr) {
        html += '<div class="fnAlertRow">';
        html += '<span class="fnAlertRowLabel">Areas</span>';
        html += `<span class="fnAlertRowValue">${whereStr}</span>`;
        html += '</div>';
    }

    if (sourceStr) {
        html += '<div class="fnAlertRow">';
        html += '<span class="fnAlertRowLabel">Source</span>';
        html += `<span class="fnAlertRowValue">${sourceStr}</span>`;
        html += '</div>';
    }

    if (hazardStr) {
        html += '<div class="fnAlertRow">';
        html += '<span class="fnAlertRowLabel">Hazard</span>';
        html += `<span class="fnAlertRowValue">${hazardStr}</span>`;
        html += '</div>';
    }

    html += '</div>';
    html += '</div>';
    html += '</div>';
    return html;
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
                _restore_pre_focus_state();
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
    if (window?.stormTrackData?.radarPreviewMode) return;
    if (!features || features.length === 0) return;

    const enabled = features.filter((f) => filter_alerts.should_show_alert_feature(f));
    if (enabled.length === 0) return;

    const wasEmpty = _alertQueue.length === 0;
    _alertQueue = _alertQueue.concat(enabled);

    if (wasEmpty) {
        _save_pre_focus_state();
        _show_next();
    }
}

function hide_focus_panel() {
    if (_focusTimeoutId) {
        clearTimeout(_focusTimeoutId);
        _focusTimeoutId = null;
    }
    _alertQueue = [];
    $('#focusNewAlertsPanel').removeClass('focusNewAlertsPanel-visible focusNewAlertsPanel-fading');
    _restore_pre_focus_state();
    requestAnimationFrame(() => {
        setTimeout(() => map.resize(), 50);
    });
}

function init() {
    if (window?.stormTrackData?.radarPreviewMode) {
        hide_focus_panel();
        return;
    }
    const panel = $('#focusNewAlertsPanel');
    if (panel.length) {
        panel.on('click', '.fnAlertClose', hide_focus_panel);
    }
}

function test_focus_alert(feature) {
    if (!feature) return;
    _save_pre_focus_state();
    _alertQueue = [feature];
    _show_next();
}

module.exports = {
    focus_on_new_alerts,
    hide_focus_panel,
    init,
    test_focus_alert
};
