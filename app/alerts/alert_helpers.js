/**
 * Shared helpers for alerts: closest WSR-88D radar, full alert body HTML.
 */
const turf = require('@turf/turf');
const nexrad_locations = require('../radar/libnexrad/nexrad_locations').NEXRAD_LOCATIONS;
const ut = require('../core/utils');
const { DateTime } = require('luxon');

/**
 * Get the closest WSR-88D (MAJOR) radar station to a point.
 * Excludes TDWR and other smaller radar types.
 * @param {number} lng - Longitude
 * @param {number} lat - Latitude
 * @returns {string|null} Station ID (e.g. 'KDIX') or null if none found
 */
function get_closest_wsr88d_radar(lng, lat) {
    const point = turf.point([lng, lat]);
    let closest = null;
    let minDist = Infinity;

    for (const [stationId, loc] of Object.entries(nexrad_locations)) {
        if (loc.type !== 'WSR-88D') continue;
        const stationPoint = turf.point([loc.lon, loc.lat]);
        const dist = turf.distance(point, stationPoint, { units: 'kilometers' });
        if (dist < minDist) {
            minDist = dist;
            closest = stationId;
        }
    }
    return closest;
}

const _RADAR_RANGE_KM = 230;
const _SEARCH_RADIUS_KM = 350;
const _W_COVERAGE = 0.55;
const _W_PROXIMITY = 0.45;

/**
 * Select the best WSR-88D radar for viewing an alert polygon.
 *
 * Scores candidates on two axes:
 *   - Coverage (55%): fraction of the alert polygon within the radar's 230 km range.
 *   - Proximity (45%): how centered the alert is within range (closer = lower beam
 *     height and better resolution).
 *
 * Falls back to closest-radar logic when no geometry is available or if turf
 * operations fail.
 *
 * @param {object|null} geometry  GeoJSON geometry of the alert (Polygon / MultiPolygon)
 * @param {number}      [fallbackLng]  Longitude to use when geometry is unavailable
 * @param {number}      [fallbackLat]  Latitude  to use when geometry is unavailable
 * @returns {string|null} Station ID or null
 */
function get_best_wsr88d_radar(geometry, fallbackLng, fallbackLat) {
    if (!geometry) {
        return (fallbackLng != null && fallbackLat != null)
            ? get_closest_wsr88d_radar(fallbackLng, fallbackLat)
            : null;
    }

    try {
        const alertFeature = turf.feature(geometry);
        const centroid = turf.centroid(alertFeature);
        const [cLng, cLat] = centroid.geometry.coordinates;
        const alertArea = turf.area(alertFeature);

        if (!alertArea || alertArea < 1) {
            return get_closest_wsr88d_radar(cLng, cLat);
        }

        let bestStation = null;
        let bestScore = -Infinity;

        for (const [stationId, loc] of Object.entries(nexrad_locations)) {
            if (loc.type !== 'WSR-88D') continue;

            const stationPt = turf.point([loc.lon, loc.lat]);
            const distKm = turf.distance(centroid, stationPt, { units: 'kilometers' });
            if (distKm > _SEARCH_RADIUS_KM) continue;

            const proximityScore = Math.max(0, 1 - distKm / _RADAR_RANGE_KM);

            let coverageScore;
            try {
                const circle = turf.circle([loc.lon, loc.lat], _RADAR_RANGE_KM, {
                    steps: 64,
                    units: 'kilometers'
                });

                if (turf.booleanContains(circle, alertFeature)) {
                    coverageScore = 1.0;
                } else {
                    const inter = turf.intersect(alertFeature, circle);
                    coverageScore = inter
                        ? Math.min(1, turf.area(inter) / alertArea)
                        : 0;
                }
            } catch (_) {
                coverageScore = distKm <= _RADAR_RANGE_KM
                    ? Math.max(0.1, 1 - distKm / _RADAR_RANGE_KM)
                    : 0;
            }

            const score = _W_COVERAGE * coverageScore + _W_PROXIMITY * proximityScore;
            if (score > bestScore) {
                bestScore = score;
                bestStation = stationId;
            }
        }

        return bestStation || get_closest_wsr88d_radar(cLng, cLat);
    } catch (_) {
        return (fallbackLng != null && fallbackLat != null)
            ? get_closest_wsr88d_radar(fallbackLng, fallbackLat)
            : null;
    }
}

function checkPropertyExists(property) {
    return (typeof property === 'undefined') ? 'None' : property;
}

function _arr(val) {
    if (Array.isArray(val) && val[0]) return val[0];
    if (typeof val === 'string') return val;
    return null;
}

// US state/territory UGC codes -> IANA timezone for alert location
const STATE_TO_TZ = {
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

function _get_state_from_ugc(properties) {
    const ugc = properties?.geocode?.UGC;
    if (ugc && (Array.isArray(ugc) ? ugc[0] : ugc)) {
        const code = Array.isArray(ugc) ? ugc[0] : ugc;
        return code.substring(0, 2).toUpperCase();
    }
    return null;
}

function _format_until(expires, properties) {
    if (!expires) return '';
    let dt = DateTime.fromISO(expires);
    if (!dt.isValid) return '';

    const state = properties ? _get_state_from_ugc(properties) : null;
    const ianaTz = state && STATE_TO_TZ[state] ? STATE_TO_TZ[state] : null;

    if (ianaTz) {
        dt = dt.setZone(ianaTz);
    }

    const tzShort = dt.offsetNameShort || 'UTC';
    return dt.toFormat('hmm a') + ' ' + tzShort;
}

function _extract_impact(description) {
    if (!description) return null;
    const match = description.match(/IMPACT\.\.\.([\s\S]+?)(?=\n\n|$)/i);
    return match ? match[1].trim().replace(/\n/g, ' ') : null;
}

function _extract_locations(description) {
    if (!description) return null;
    const match = description.match(/Locations impacted include\.\.\.\s*([\s\S]+?)(?:\n\n|$)/i);
    if (match) {
        return match[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return null;
}

function _extract_region_from_headline(nwsHeadline) {
    if (!nwsHeadline) return null;
    const match = nwsHeadline.match(/FOR\s+([^.]+?)(?:\.|$)/i);
    return match ? match[1].trim() : null;
}

const CONVECTIVE_EVENTS = [
    'Tornado Emergency', 'PDS Tornado Warning', 'Tornado Warning',
    'Severe Thunderstorm Warning', 'Severe Thunderstorm Watch', 'Tornado Watch'
];

/** Severe convective alerts we want to stay on radar for; non-severe will return to this site when done. */
function is_severe_weather_alert(event) {
    return CONVECTIVE_EVENTS.includes(event || '');
}

/**
 * Build the full alert detail body HTML in RadarOmega-style layout.
 * @param {object} properties - Alert feature properties
 * @returns {string} HTML string for the detail panel
 */
function build_full_alert_body(properties) {
    const params = properties.parameters
        ? (typeof properties.parameters === 'string'
            ? JSON.parse(properties.parameters)
            : properties.parameters)
        : {};
    const desc = (properties.description || '').toUpperCase();
    const event = properties.event || 'Alert';
    const isConvective = CONVECTIVE_EVENTS.includes(event);

    // What to expect - summary line
    let whatToExpect = '';
    if (event === 'Tornado Warning' || event === 'Tornado Emergency' || event === 'PDS Tornado Warning') {
        whatToExpect = 'Tornado.';
    } else if (event === 'Severe Thunderstorm Warning') {
        const wind = _arr(params.maxWindGust);
        const hail = _arr(params.maxHailSize);
        const hailNum = parseFloat(hail);
        const hailValid = hail && !isNaN(hailNum);
        const hStr = hailValid ? (hailNum > 0 && hailNum < 1 ? '<' + hail.replace(/^0\./, '.') + '"' : hailNum.toFixed(2) + '"') : '0.00"';
        if (wind && hailValid) {
            whatToExpect = `${wind} wind gusts and ${hStr} hail.`;
        } else if (wind) {
            whatToExpect = `${wind} wind gusts.`;
        } else if (hailValid) {
            whatToExpect = `${hStr} hail.`;
        } else {
            whatToExpect = 'Severe thunderstorms.';
        }
    } else if (event === 'Flash Flood Warning') {
        whatToExpect = 'Flash flooding.';
    } else {
        whatToExpect = properties.headline || event;
        if (whatToExpect.length > 120) whatToExpect = whatToExpect.substring(0, 117) + '...';
    }

    // Source string
    let sourceStr = _arr(params.flashFloodDetection);
    if (event === 'Tornado Warning' || event === 'Tornado Emergency' || event === 'PDS Tornado Warning') {
        sourceStr = sourceStr || (desc.includes('RADAR INDICATED') ? 'Radar indicated rotation.' : null) || (_arr(params.tornadoDetection) ? 'Radar indicated rotation.' : null);
    }
    if (!sourceStr && (desc.includes('RADAR INDICATED') || desc.includes('RADAR-INDICATED'))) {
        sourceStr = 'Radar indicated.';
    }
    if (!sourceStr && isConvective) {
        sourceStr = _arr(params.windThreat) || _arr(params.hailThreat) || 'Radar indicated.';
    }

    // Where - locations or areaDesc
    let whereStr = _extract_locations(properties.description) || properties.areaDesc || '';
    if (whereStr && whereStr.length > 300) whereStr = whereStr.substring(0, 297) + '...';

    // When
    const expires = properties.expires || properties.ends || _arr(params.eventEndingTime);
    const untilStr = _format_until(expires, properties);
    const nwsHeadline = _arr(params.NWSheadline) || properties.headline || '';
    const regionStr = _extract_region_from_headline(nwsHeadline) || properties.areaDesc || '';
    const whenStr = untilStr && regionStr ? `UNTIL ${untilStr} FOR ${regionStr.toUpperCase()}` : untilStr ? `UNTIL ${untilStr}` : regionStr ? regionStr.toUpperCase() : '';

    // Expected impacts (from IMPACT... in description, or instruction)
    let impactStr = _extract_impact(properties.description);
    if (!impactStr && properties.instruction) {
        impactStr = properties.instruction.substring(0, 300);
        if (properties.instruction.length > 300) impactStr += '...';
    }

    // Threat summary (Tornado: X, Hail: X, Wind: X, Damage Threat: X)
    const isTornadoWarning = event === 'Tornado Warning' || event === 'Tornado Emergency' || event === 'PDS Tornado Warning';
    const tornadoVal = _arr(params.tornadoDetection);
    const tornadoDisplay = isTornadoWarning
        ? (tornadoVal || (desc.includes('RADAR INDICATED') ? 'RADAR INDICATED' : null) || (desc.includes('POSSIBLE') ? 'POSSIBLE' : null))
        : null;
    const hailVal = _arr(params.maxHailSize);
    const hailNum = parseFloat(hailVal);
    const hailDisplay = hailVal && !isNaN(hailNum)
        ? (hailNum < 1 ? '<' + hailVal.replace(/^0\./, '.') + '"' : hailNum.toFixed(2) + '"')
        : '0.00"';
    const windVal = _arr(params.maxWindGust);
    const damageThreat = _arr(params.flashFloodDamageThreat) || _arr(params.damageThreat);

    let sections = [];

    // WHAT TO EXPECT
    sections.push(`
<div class="alertInfoSection">
  <div class="alertInfoSectionTitle">WHAT TO EXPECT</div>
  <div class="alertInfoWhatToExpect">${whatToExpect}</div>
  <div class="alertInfoCards">`);

    if (isConvective && windVal) {
        sections.push(`
    <div class="alertInfoCard">
      <span class="alertInfoCardIcon"><i class="fa-solid fa-wind"></i></span>
      <div class="alertInfoCardLabel">MAX WIND</div>
      <div class="alertInfoCardValue">${windVal}</div>
    </div>`);
    }
    if (sourceStr) {
        sections.push(`
    <div class="alertInfoCard">
      <span class="alertInfoCardIcon"><i class="fa-solid fa-satellite-dish"></i></span>
      <div class="alertInfoCardLabel">SOURCE</div>
      <div class="alertInfoCardValue">${sourceStr}</div>
    </div>`);
    }
    if ((event === 'Tornado Warning' || event === 'Tornado Emergency' || event === 'PDS Tornado Warning') && !windVal && !sourceStr) {
        sections.push(`
    <div class="alertInfoCard alertInfoCardSource">
      <span class="alertInfoCardIcon"><i class="fa-solid fa-satellite-dish"></i></span>
      <div class="alertInfoCardLabel">SOURCE</div>
      <div class="alertInfoCardValue">Radar indicated rotation.</div>
    </div>`);
    }

    sections.push(`
  </div>`);

    // Threat summary (Tornado, Hail, Wind, Damage Threat) - directly below cards, centered
    if (isConvective && (tornadoDisplay || windVal || damageThreat)) {
        const threatParts = [];
        if (tornadoDisplay) threatParts.push(`Tornado: <span class="alertInfoHighlight">${tornadoDisplay.toUpperCase()}</span>`);
        threatParts.push(`Hail: ${hailDisplay}`);
        if (windVal) threatParts.push(`Wind: <span class="alertInfoHighlight">${windVal}</span>`);
        if (damageThreat) threatParts.push(`Damage Threat: <span class="alertInfoHighlight alertInfoDamage">${damageThreat.toUpperCase()}</span>`);
        sections.push(`
  <div class="alertInfoThreatSummary">${threatParts.join(' ')}</div>`);
    }

    // Where
    if (whereStr) {
        sections.push(`
  <div class="alertInfoRow">
    <span class="alertInfoRowIcon alertInfoPin"><i class="fa-solid fa-location-dot"></i></span>
    <div class="alertInfoRowContent">
      <span class="alertInfoRowLabel">Where</span>
      <span class="alertInfoRowValue">${whereStr}</span>
    </div>
  </div>`);
    }

    // When
    if (whenStr) {
        sections.push(`
  <div class="alertInfoRow">
    <span class="alertInfoRowIcon alertInfoClock"><i class="fa-solid fa-clock"></i></span>
    <div class="alertInfoRowContent">
      <span class="alertInfoRowLabel">When</span>
      <span class="alertInfoRowValue">${whenStr}</span>
    </div>
  </div>`);
    }

    sections.push(`
</div>`);

    // EXPECTED IMPACTS
    if (impactStr) {
        sections.push(`
<div class="alertInfoSection">
  <span class="alertInfoWarningIcon"><i class="fa-solid fa-triangle-exclamation"></i></span>
  <div class="alertInfoSectionTitle">EXPECTED IMPACTS</div>
  <div class="alertInfoImpact">${impactStr}</div>`);

        sections.push(`
</div>`);
    }

    // Raw bulletin
    const rawText = (nwsHeadline ? nwsHeadline + '\n\n' : '') + (properties.description || '');
    sections.push(`
<div class="alertInfoSection alertInfoRawSection">
  <div class="alertInfoRawText">${(rawText || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</div>
</div>`);

    return `<div class="alertInfoPanel">${sections.join('')}</div>`;
}

module.exports = {
    get_closest_wsr88d_radar,
    get_best_wsr88d_radar,
    build_full_alert_body,
    checkPropertyExists,
    is_severe_weather_alert
};
