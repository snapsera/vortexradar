/**
 * 24/7 Live Mode — autonomous radar broadcast director.
 *
 * Cycles through SPC Day 1 outlooks, active severe alerts, and CONUS MRMS
 * radar in a weighted-random sequence. Tornado warnings preempt the current
 * segment immediately.
 */
const map = require('../core/map/map');
const turf = require('@turf/turf');
const chroma = require('chroma-js');
const settings_store = require('../core/menu/settings_store');
const alert_helpers = require('../alerts/alert_helpers');
const filter_alerts = require('../alerts/filter_alerts');
const get_polygon_colors = require('../alerts/colors/polygon_colors');
const station_markers = require('../radar/station_markers/station_markers');
const nexrad_locations = require('../radar/libnexrad/nexrad_locations').NEXRAD_LOCATIONS;

// ── Constants ────────────────────────────────────────────────────────────────

const SPC_BASE_URL = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/MapServer';
const DAY1_LAYERS = { categorical: 1, tornado: 3, hail: 5, wind: 7 };
const SPC_HAZARDS = ['categorical', 'tornado', 'wind', 'hail'];
const SPC_SOURCE_ID = 'liveModeSpcSource';
const SPC_HATCH_SOURCE_ID = 'liveModeSpcHatchedSource';
const SPC_FILL_LAYER = 'liveModeSpcFill';
const SPC_LINE_LAYER = 'liveModeSpcLine';
const SPC_HATCH_LINE_LAYER = 'liveModeSpcHatchLine';

const CONUS_CENTER = [-98.5606744, 39.5];
const CONUS_ZOOM = 4.3;

const TORNADO_EVENTS = ['Tornado Warning', 'PDS Tornado Warning', 'Tornado Emergency'];
const SEVERE_ALERT_EVENTS = [
    'Tornado Emergency', 'PDS Tornado Warning', 'Tornado Warning',
    'Severe Thunderstorm Warning', 'Flash Flood Warning',
    'Evacuation - Immediate'
];

const SPC_SEGMENT_DURATION_MS = 18000;
const ALERT_SEGMENT_DURATION_MS = 25000;
const CONUS_SEGMENT_DURATION_MS = 22000;
const SPOTLIGHT_DURATION_MS = 20000;
const VELOCITY_HOLD_MS = 8000;
const PLAYBACK_LOOP_TARGET = 8;
const PLAYBACK_SPEED = 10;
const PLAYBACK_FRAME_COUNT = 14;

const EARTHQUAKE_DURATION_MS = 22000;
const EARTHQUAKE_FEED_URL = '/api/earthquakes';
const LM_QUAKE_SOURCE = 'lmQuakeSource';
const LM_QUAKE_CIRCLE = 'lmQuakeCircle';
const LM_QUAKE_LABEL = 'lmQuakeLabel';
const LM_QUAKE_PULSE = 'lmQuakePulse';

const SEGMENT_WEIGHTS = { spc: 3, alert: 5, conus: 2, spotlight: 4, conditions: 3, earthquake: 2 };

// ── State ────────────────────────────────────────────────────────────────────

let _active = false;
let _segmentTimer = null;
let _currentSegmentType = null;

let _preSaveState = null;
let _recentSegments = [];
let _loopCount = 0;
let _loopListener = null;
let _lastFrameIndex = -1;
let _tornadoInterruptListener = null;
let _escapeListener = null;
let _focusGlowTimer = null;
let _focusGlowDir = 1;
let _focusGlowOpacity = 0;
let _alertEpoch = 0;
let _alertPendingTimers = [];
let _scanLoadListener = null;

const LM_FOCUS_SOURCE = 'lmFocusGlowSource';
const LM_FOCUS_GLOW_OUTER = 'lmFocusGlowOuter';
const LM_FOCUS_GLOW_INNER = 'lmFocusGlowInner';

const LM_TRACK_SOURCE = 'lmStormTrackSource';
const LM_TRACK_LINE_LAYER = 'lmStormTrackLine';
const LM_TRACK_ARROW_LAYER = 'lmStormTrackArrow';

const MAPBOX_TOKEN = 'pk.eyJ1IjoidHdhbGtlcjkyIiwiYSI6ImNtZDkwaHMwdTAyazkya3BzNXphYWI3a2kifQ.sWYO653OYlYHYc_wOHsd2A';

const DIR_MAP = {
    'north': 0, 'n': 0, 'nne': 22.5, 'ne': 45, 'north-northeast': 22.5, 'northeast': 45,
    'ene': 67.5, 'east-northeast': 67.5, 'east': 90, 'e': 90, 'ese': 112.5, 'east-southeast': 112.5,
    'se': 135, 'southeast': 135, 'sse': 157.5, 'south-southeast': 157.5,
    'south': 180, 's': 180, 'ssw': 202.5, 'south-southwest': 202.5,
    'sw': 225, 'southwest': 225, 'wsw': 247.5, 'west-southwest': 247.5,
    'west': 270, 'w': 270, 'wnw': 292.5, 'west-northwest': 292.5,
    'nw': 315, 'northwest': 315, 'nnw': 337.5, 'north-northwest': 337.5
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function _get_active_severe_alerts() {
    const data = window.stormTrackData?.alerts_data;
    if (!data || !data.features) return [];
    const seen = new Set();
    return data.features.filter(function (f) {
        const id = f.id || f?.properties?.id;
        if (!id || seen.has(id) || !f.geometry) return false;
        seen.add(id);
        const ev = f?.properties?.event;
        return SEVERE_ALERT_EVENTS.includes(ev) && filter_alerts.should_show_alert_feature(f);
    });
}

function _is_tornado_eligible(feature) {
    const p = feature?.properties || {};
    const ev = p.event || '';
    if (TORNADO_EVENTS.includes(ev)) return true;
    if (ev !== 'Severe Thunderstorm Warning') return false;
    const params = typeof p.parameters === 'string' ? JSON.parse(p.parameters) : (p.parameters || {});
    const det = Array.isArray(params.tornadoDetection) ? params.tornadoDetection[0] : params.tornadoDetection;
    if (det && String(det).toLowerCase().includes('possible')) return true;
    const desc = (p.description || '').toUpperCase();
    return desc.includes('TORNADO POSSIBLE') || desc.includes('POSSIBLE TORNADO');
}

function _pick_random(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function _weighted_pick(options) {
    let total = 0;
    for (const o of options) total += o.weight;
    let r = Math.random() * total;
    for (const o of options) {
        r -= o.weight;
        if (r <= 0) return o.type;
    }
    return options[options.length - 1].type;
}

function _was_recent(type, id) {
    return _recentSegments.some(function (s) { return s.type === type && s.id === id; });
}

function _record_segment(type, id) {
    _recentSegments.push({ type: type, id: id, ts: Date.now() });
    if (_recentSegments.length > 12) _recentSegments.shift();
}

function _recent_type_count(type, lookback) {
    var n = lookback || 4;
    var slice = _recentSegments.slice(-n);
    var count = 0;
    for (var i = 0; i < slice.length; i++) {
        if (slice[i].type === type) count++;
    }
    return count;
}

// ── Header Clock Control ─────────────────────────────────────────────────────

function _set_clock_mode(mode) {
    var $clock = $('#headerClock');
    var $lines = $clock.find('.headerClockLine');
    if (!$clock.length) return;
    if (mode === 'site-only') {
        $lines.eq(0).hide();
        $lines.eq(1).show();
    } else if (mode === 'hidden') {
        $lines.hide();
    } else {
        $lines.show();
    }
}

// ── Header Radar Info Control ────────────────────────────────────────────────

var _SPC_RISK_LEVEL = {
    'TSTM': { num: '0', name: 'General Thunder', color: '#c1e9c1' },
    'MRGL': { num: '1', name: 'Marginal', color: '#66c566' },
    'SLGT': { num: '2', name: 'Slight', color: '#f6f67f' },
    'ENH':  { num: '3', name: 'Enhanced', color: '#e5993e' },
    'MDT':  { num: '4', name: 'Moderate', color: '#e5433e' },
    'HIGH': { num: '5', name: 'HIGH', color: '#ff52ff' }
};

function _hide_header_radar_info(riskLabel) {
    var $info = $('#radarInfoSpan');
    $info.data('lm-was-visible', $info.is(':visible'));
    $info.hide();
    var $lmHeader = $('#lmHeaderInfo');
    if (!$lmHeader.length) {
        $('<span id="lmHeaderInfo" style="font-size:14px;font-weight:600;letter-spacing:0.02em;"></span>')
            .insertAfter($info);
        $lmHeader = $('#lmHeaderInfo');
    }
    if (riskLabel) {
        $lmHeader.html(riskLabel).show();
    } else {
        $lmHeader.html('').show();
    }
}

function _show_header_radar_info() {
    var $lmHeader = $('#lmHeaderInfo');
    if ($lmHeader.length) $lmHeader.hide().html('');
    var $info = $('#radarInfoSpan');
    if ($info.data('lm-was-visible')) {
        $info.show();
    }
}

function _classify_risk(props) {
    var label = String(props.label || '').toUpperCase().trim();
    var label2 = String(props.label2 || '').toUpperCase().trim();
    var text = label + ' ' + label2;
    if (text.indexOf('HIGH') !== -1 || label === 'HIGH') return 'HIGH';
    if (text.indexOf('MODERATE') !== -1 || label === 'MDT') return 'MDT';
    if (text.indexOf('ENHANCED') !== -1 || label === 'ENH') return 'ENH';
    if (text.indexOf('SLIGHT') !== -1 || label === 'SLGT') return 'SLGT';
    if (text.indexOf('MARGINAL') !== -1 || label === 'MRGL') return 'MRGL';
    if (text.indexOf('GENERAL THUNDER') !== -1 || label === 'TSTM' || text.indexOf('THUNDERSTORM') !== -1) return 'TSTM';
    return null;
}

function _build_risk_label(geojson) {
    if (!geojson || !geojson.features || !geojson.features.length) return null;
    var highest = null;
    var order = ['TSTM', 'MRGL', 'SLGT', 'ENH', 'MDT', 'HIGH'];
    for (var i = 0; i < geojson.features.length; i++) {
        var risk = _classify_risk(geojson.features[i]?.properties || {});
        if (!risk) continue;
        var idx = order.indexOf(risk);
        if (idx >= 0 && (!highest || idx > order.indexOf(highest))) highest = risk;
    }
    if (!highest) return null;
    var info = _SPC_RISK_LEVEL[highest];
    if (!info) return null;
    return '<span style="color:' + info.color + ';font-size:15px">' + info.num + '/5</span>' +
        ' <span style="color:rgba(255,255,255,0.5);font-size:12px">' + info.name + ' Risk</span>';
}

// ── Storm Motion Parsing ─────────────────────────────────────────────────────

function _extract_storm_motion(feature) {
    var p = feature?.properties || {};
    var desc = p.description || '';
    var params = p.parameters ? (typeof p.parameters === 'string' ? JSON.parse(p.parameters) : p.parameters) : {};

    var speedMph = null;
    var bearingDeg = null;
    var stormLat = null;
    var stormLon = null;

    var tml = desc.match(/TIME\.\.\.MOT\.\.\.LOC\s+\d{4}Z?\s+(\d{3})DEG\s+(\d{1,3})KT\s+([\d.]+)\s+(-?[\d.]+)/i);
    if (tml) {
        bearingDeg = parseInt(tml[1], 10);
        speedMph = Math.round(parseInt(tml[2], 10) * 1.15078);
        stormLat = parseFloat(tml[3]);
        stormLon = parseFloat(tml[4]);
        if (stormLon > 0) stormLon = -stormLon;
    }

    if (bearingDeg == null) {
        var movePat = /MOVING\s+([\w-]+)\s+AT\s+(\d{1,3})\s*(MPH|KT|KTS|KNOTS?)/i;
        var moveMatch = desc.match(movePat);
        if (moveMatch) {
            var dirStr = moveMatch[1].toLowerCase().replace(/\s+/g, '');
            bearingDeg = DIR_MAP[dirStr] != null ? DIR_MAP[dirStr] : null;
            var rawSpeed = parseInt(moveMatch[2], 10);
            var unit = moveMatch[3].toLowerCase();
            speedMph = unit === 'mph' ? rawSpeed : Math.round(rawSpeed * 1.15078);
        }
    }

    if (speedMph == null) {
        var patterns = [
            /moving\s+[a-z\-\s]+?\s+at\s+(\d{1,3})\s*(mph|kt|kts|knot|knots)\b/i,
            /moving\s+at\s+(\d{1,3})\s*(mph|kt|kts|knot|knots)\b/i
        ];
        for (var pi = 0; pi < patterns.length; pi++) {
            var mm = desc.match(patterns[pi]);
            if (mm && mm[1]) {
                var sp = parseInt(mm[1], 10);
                var u = (mm[2] || 'mph').toLowerCase();
                speedMph = u === 'mph' ? sp : Math.round(sp * 1.15078);
                break;
            }
        }
    }

    if (bearingDeg == null) {
        var dirOnly = desc.match(/MOVING\s+([\w-]+)/i);
        if (dirOnly) {
            var dk = dirOnly[1].toLowerCase().replace(/\s+/g, '');
            if (DIR_MAP[dk] != null) bearingDeg = DIR_MAP[dk];
        }
    }

    if (!stormLat && feature.geometry) {
        try {
            var c = turf.centroid(turf.feature(feature.geometry));
            stormLat = c.geometry.coordinates[1];
            stormLon = c.geometry.coordinates[0];
        } catch (_) {}
    }

    if (bearingDeg == null || speedMph == null) return null;
    return { bearingDeg: bearingDeg, speedMph: speedMph, stormLat: stormLat, stormLon: stormLon };
}

function _bearing_to_cardinal(deg) {
    var dirs = ['north', 'north-northeast', 'northeast', 'east-northeast', 'east', 'east-southeast', 'southeast', 'south-southeast', 'south', 'south-southwest', 'southwest', 'west-southwest', 'west', 'west-northwest', 'northwest', 'north-northwest'];
    return dirs[Math.round(((deg % 360 + 360) % 360) / 22.5) % 16];
}

function _bearing_to_short(deg) {
    var dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return dirs[Math.round(((deg % 360 + 360) % 360) / 22.5) % 16];
}

// ── City Lookup (Mapbox) ─────────────────────────────────────────────────────

function _find_major_city_in_polygon(feature, callback) {
    if (!feature || !feature.geometry) return callback(null);
    try {
        var centroid = turf.centroid(turf.feature(feature.geometry));
        var coords = centroid.geometry.coordinates;
        var url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/' +
            coords[0].toFixed(4) + ',' + coords[1].toFixed(4) +
            '.json?types=place&limit=1&access_token=' + MAPBOX_TOKEN;
        fetch(url)
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                if (!data || !data.features || !data.features.length) return callback(null);
                var place = data.features[0];
                callback({
                    name: place.text || place.place_name,
                    lng: place.center[0],
                    lat: place.center[1]
                });
            })
            .catch(function () { callback(null); });
    } catch (_) { callback(null); }
}

function _city_distance_miles(motion, city) {
    if (!motion || !city || motion.stormLat == null || city.lat == null) return null;
    try {
        return turf.distance(
            turf.point([motion.stormLon, motion.stormLat]),
            turf.point([city.lng, city.lat]),
            { units: 'miles' }
        );
    } catch (_) { return null; }
}

function _city_eta_minutes(distMiles, speedMph) {
    if (!distMiles || !speedMph || speedMph <= 0) return null;
    return Math.round((distMiles / speedMph) * 60);
}

// ── Storm Track Layer ────────────────────────────────────────────────────────

function _add_storm_track(motion, feature) {
    _remove_storm_track();
    if (!motion || motion.stormLat == null || motion.stormLon == null) return;

    var startPt = [motion.stormLon, motion.stormLat];
    var distanceMiles = motion.speedMph * 1.0;
    var endPt = turf.destination(turf.point(startPt), distanceMiles * 1.60934, motion.bearingDeg, { units: 'kilometers' });
    var endCoords = endPt.geometry.coordinates;

    var geojson = turf.featureCollection([
        turf.lineString([startPt, endCoords], { role: 'track' }),
        turf.point(endCoords, { role: 'arrow' })
    ]);

    map.addSource(LM_TRACK_SOURCE, { type: 'geojson', data: geojson });

    map.addLayer({
        id: LM_TRACK_LINE_LAYER,
        type: 'line',
        source: LM_TRACK_SOURCE,
        filter: ['==', ['get', 'role'], 'track'],
        paint: {
            'line-color': '#ffffff',
            'line-width': 3,
            'line-opacity': 0.55,
            'line-dasharray': [4, 3]
        }
    });

    map.addLayer({
        id: LM_TRACK_ARROW_LAYER,
        type: 'circle',
        source: LM_TRACK_SOURCE,
        filter: ['==', ['get', 'role'], 'arrow'],
        paint: {
            'circle-radius': 5,
            'circle-color': '#ffffff',
            'circle-opacity': 0.7,
            'circle-stroke-width': 1.5,
            'circle-stroke-color': 'rgba(255,255,255,0.4)'
        }
    });
}

function _remove_storm_track() {
    try { if (map.getLayer(LM_TRACK_ARROW_LAYER)) map.removeLayer(LM_TRACK_ARROW_LAYER); } catch (_) {}
    try { if (map.getLayer(LM_TRACK_LINE_LAYER)) map.removeLayer(LM_TRACK_LINE_LAYER); } catch (_) {}
    try { if (map.getSource(LM_TRACK_SOURCE)) map.removeSource(LM_TRACK_SOURCE); } catch (_) {}
}

// ── SPC Outlook Segment ──────────────────────────────────────────────────────

function _fetch_spc_geojson(hazard) {
    const layerId = DAY1_LAYERS[hazard] || DAY1_LAYERS.categorical;
    const url = SPC_BASE_URL + '/' + layerId + '/query?where=1%3D1&outFields=*&f=geojson';
    return fetch(url, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (json) {
            if (!json || json.type !== 'FeatureCollection') return { type: 'FeatureCollection', features: [] };
            return json;
        })
        .catch(function () { return { type: 'FeatureCollection', features: [] }; });
}

function _is_hatched_feature(props) {
    var label = String(props.label || '').toLowerCase();
    var label2 = String(props.label2 || '').toLowerCase();
    return label.indexOf('hatched') !== -1 || label2.indexOf('hatched') !== -1;
}

function _is_cig_feature(props) {
    var label = String(props.label || '').toUpperCase();
    var label2 = String(props.label2 || '').toUpperCase();
    return label.indexOf('CIG') === 0 || label2.indexOf('CONDITIONAL INTENSITY GROUP') !== -1;
}

function _add_spc_layers(geojson) {
    _remove_spc_layers();

    var regular = [];
    var hatched = [];

    var allFeatures = (geojson.features || []).filter(function (f) { return f.geometry; });
    for (var i = 0; i < allFeatures.length; i++) {
        var f = allFeatures[i];
        var p = Object.assign({}, f.properties || {});
        var feat = { type: 'Feature', geometry: f.geometry, properties: p };
        if (_is_cig_feature(p) || _is_hatched_feature(p)) {
            hatched.push(feat);
        } else {
            regular.push(feat);
        }
    }

    if (!regular.length && !hatched.length) return;

    if (regular.length) {
        map.addSource(SPC_SOURCE_ID, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: regular }
        });

        map.addLayer({
            id: SPC_FILL_LAYER,
            type: 'fill',
            source: SPC_SOURCE_ID,
            paint: {
                'fill-color': ['coalesce', ['get', 'fill'], '#8dc6ff'],
                'fill-opacity': 0.75
            }
        });

        map.addLayer({
            id: SPC_LINE_LAYER,
            type: 'line',
            source: SPC_SOURCE_ID,
            paint: {
                'line-color': ['coalesce', ['get', 'stroke'], '#59a9ff'],
                'line-width': 2,
                'line-opacity': 0.9
            }
        });
    }

    if (hatched.length) {
        map.addSource(SPC_HATCH_SOURCE_ID, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: hatched }
        });

        map.addLayer({
            id: SPC_HATCH_LINE_LAYER,
            type: 'line',
            source: SPC_HATCH_SOURCE_ID,
            paint: {
                'line-color': ['coalesce', ['get', 'stroke'], '#59a9ff'],
                'line-width': 2.2,
                'line-opacity': 1,
                'line-dasharray': [2, 1.5]
            }
        });
    }
}

function _remove_spc_layers() {
    if (map.getLayer(SPC_HATCH_LINE_LAYER)) map.removeLayer(SPC_HATCH_LINE_LAYER);
    if (map.getLayer(SPC_LINE_LAYER)) map.removeLayer(SPC_LINE_LAYER);
    if (map.getLayer(SPC_FILL_LAYER)) map.removeLayer(SPC_FILL_LAYER);
    if (map.getSource(SPC_HATCH_SOURCE_ID)) map.removeSource(SPC_HATCH_SOURCE_ID);
    if (map.getSource(SPC_SOURCE_ID)) map.removeSource(SPC_SOURCE_ID);
}

function _spc_label(hazard) {
    return 'DAY 1 ' + hazard.toUpperCase() + ' OUTLOOK';
}

function _format_spc_time(raw) {
    if (!raw) return null;
    var s = String(raw).trim();
    if (!/^\d{12}$/.test(s)) return null;
    var utcDate = new Date(Date.UTC(
        Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)),
        Number(s.slice(8, 10)), Number(s.slice(10, 12))
    ));
    if (!Number.isFinite(utcDate.getTime())) return null;
    var dateLabel = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric'
    }).format(utcDate);
    var timeLabel = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short'
    }).format(utcDate);
    return dateLabel + ', ' + timeLabel;
}

function _parse_spc_timestamp(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    var s = String(raw).trim();
    if (/^\d{12}$/.test(s)) {
        var utcDate = new Date(Date.UTC(
            Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)),
            Number(s.slice(8, 10)), Number(s.slice(10, 12))
        ));
        return Number.isFinite(utcDate.getTime()) ? utcDate : null;
    }
    var n = Number(s);
    if (Number.isFinite(n) && n > 0) {
        var d = new Date(n);
        return Number.isFinite(d.getTime()) ? d : null;
    }
    return null;
}

function _get_spc_validity(geojson) {
    var features = (geojson && geojson.features) || [];
    var first = features[0] && features[0].properties ? features[0].properties : null;
    var validFrom = _format_spc_time(first && first.valid) || null;
    var validUntil = _format_spc_time(first && first.expire) || null;

    var latestMs = 0;
    for (var i = 0; i < features.length; i++) {
        var p = (features[i] && features[i].properties) || {};
        var best = _parse_spc_timestamp(p.issue) || _parse_spc_timestamp(p.idp_filedate) || _parse_spc_timestamp(p.idp_ingestdate);
        if (best && best.getTime() > latestMs) latestMs = best.getTime();
    }
    var lastUpdated = null;
    if (latestMs) {
        var d = new Date(latestMs);
        var datePart = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric'
        }).format(d);
        var timePart = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short'
        }).format(d);
        lastUpdated = datePart + ', ' + timePart;
    }

    return { validFrom: validFrom, validUntil: validUntil, lastUpdated: lastUpdated };
}

var radar_scan_animation = require('../radar/station_markers/radar_scan_animation');

var ALERT_LAYER_IDS = ['alertsLayer', 'alertsLayerFill', 'alertsBlinkLayer', 'alertsDashedLayer'];

function _hide_radar_render() {
    try {
        if (map.getLayer('baseReflectivity')) map.setLayoutProperty('baseReflectivity', 'visibility', 'none');
        if (map.getLayer('station_range_layer')) map.setLayoutProperty('station_range_layer', 'visibility', 'none');
    } catch (_) {}
}

function _show_radar_render() {
    try {
        if (map.getLayer('baseReflectivity')) map.setLayoutProperty('baseReflectivity', 'visibility', 'visible');
        var radiusEnabled = $('#armrRadarRadiusBtnSwitchElem').is(':checked');
        if (map.getLayer('station_range_layer') && radiusEnabled) {
            map.setLayoutProperty('station_range_layer', 'visibility', 'visible');
        }
    } catch (_) {}
}

function _hide_station_markers() {
    try {
        if (map.getLayer('stationSymbolLayer')) map.setLayoutProperty('stationSymbolLayer', 'visibility', 'none');
    } catch (_) {}
}

function _show_station_markers() {
    try {
        if (map.getLayer('stationSymbolLayer')) map.setLayoutProperty('stationSymbolLayer', 'visibility', 'visible');
    } catch (_) {}
}

function _hide_alert_polygons() {
    try {
        for (var i = 0; i < ALERT_LAYER_IDS.length; i++) {
            if (map.getLayer(ALERT_LAYER_IDS[i])) map.setLayoutProperty(ALERT_LAYER_IDS[i], 'visibility', 'none');
        }
    } catch (_) {}
}

function _show_alert_polygons() {
    try {
        for (var i = 0; i < ALERT_LAYER_IDS.length; i++) {
            if (map.getLayer(ALERT_LAYER_IDS[i])) map.setLayoutProperty(ALERT_LAYER_IDS[i], 'visibility', 'visible');
        }
    } catch (_) {}
}

function _hide_radar_sweep() {
    try { radar_scan_animation.remove(); } catch (_) {}
}

function _show_radar_sweep() {
    try {
        var s = settings_store.load();
        if (s.radarSweep) radar_scan_animation.update();
    } catch (_) {}
}

function _hide_all_map_overlays() {
    _hide_radar_render();
    _hide_station_markers();
    _hide_alert_polygons();
    _hide_radar_sweep();
}

function _show_all_map_overlays() {
    _show_radar_render();
    _show_station_markers();
    _show_alert_polygons();
    _show_radar_sweep();
}

function _run_spc_segment(resolve) {
    var hazard = _pick_random(SPC_HAZARDS.filter(function (h) { return !_was_recent('spc', h); }));
    if (!hazard) hazard = _pick_random(SPC_HAZARDS);
    _record_segment('spc', hazard);
    _currentSegmentType = 'spc';

    _set_clock_mode('hidden');
    _hide_radar_render();
    _hide_station_markers();
    _hide_radar_sweep();
    _hide_header_radar_info(null);
    _show_info_panel(_build_spc_panel_html(_spc_label(hazard)));

    var catPromise = (hazard !== 'categorical')
        ? _fetch_spc_geojson('categorical')
        : Promise.resolve(null);

    Promise.all([_fetch_spc_geojson(hazard), catPromise]).then(function (results) {
        var geojson = results[0];
        var catGeojson = results[1];
        if (!_active) { _show_radar_render(); _show_station_markers(); _show_radar_sweep(); _show_header_radar_info(); return resolve(); }

        var features = (geojson && geojson.features) ? geojson.features.filter(function (f) { return f.geometry; }) : [];
        if (features.length) {
            try {
                var bbox = turf.bbox(geojson);
                if (bbox && isFinite(bbox[0])) {
                    map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], {
                        padding: 60, maxZoom: 10, speed: 1.2, essential: true
                    });
                } else {
                    map.flyTo({ center: CONUS_CENTER, zoom: CONUS_ZOOM, speed: 1.2, essential: true });
                }
            } catch (_) {
                map.flyTo({ center: CONUS_CENTER, zoom: CONUS_ZOOM, speed: 1.2, essential: true });
            }
        } else {
            map.flyTo({ center: CONUS_CENTER, zoom: CONUS_ZOOM, speed: 1.2, essential: true });
        }

        _add_spc_layers(geojson);
        var validity = _get_spc_validity(geojson);
        _show_info_panel(_build_spc_panel_html(_spc_label(hazard), validity));
        var riskHtml = _build_risk_label(geojson) || _build_risk_label(catGeojson);
        _hide_header_radar_info(riskHtml);
        if (Math.random() > 0.35) {
            _typewrite(_generate_spc_commentary(hazard, geojson), 1200);
        }
        _segmentTimer = setTimeout(function () {
            _wait_for_typewriter_then(function () {
                _stop_typewriter();
                _remove_spc_layers();
                _show_radar_render();
                _show_station_markers();
                _show_radar_sweep();
                _show_header_radar_info();
                _hide_info_panel();
                resolve();
            });
        }, SPC_SEGMENT_DURATION_MS);
    });
}

// ── Alert Focus Glow ─────────────────────────────────────────────────────────

function _add_focus_glow(feature) {
    _remove_focus_glow();
    if (!feature || !feature.geometry) return;

    var geojson = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: feature.geometry, properties: {} }] };

    map.addSource(LM_FOCUS_SOURCE, { type: 'geojson', data: geojson });

    map.addLayer({
        id: LM_FOCUS_GLOW_OUTER,
        type: 'line',
        source: LM_FOCUS_SOURCE,
        paint: {
            'line-color': '#ffffff',
            'line-width': 18,
            'line-opacity': 0,
            'line-blur': 12
        }
    });

    map.addLayer({
        id: LM_FOCUS_GLOW_INNER,
        type: 'line',
        source: LM_FOCUS_SOURCE,
        paint: {
            'line-color': '#ffffff',
            'line-width': 6,
            'line-opacity': 0,
            'line-blur': 3
        }
    });

    _focusGlowOpacity = 0;
    _focusGlowDir = 1;

    function _pulse() {
        if (!_active) { _remove_focus_glow(); return; }
        if (!map.getLayer(LM_FOCUS_GLOW_OUTER)) return;

        _focusGlowOpacity += _focusGlowDir * 0.025;
        if (_focusGlowOpacity >= 0.9) { _focusGlowOpacity = 0.9; _focusGlowDir = -1; }
        if (_focusGlowOpacity <= 0.25) { _focusGlowOpacity = 0.25; _focusGlowDir = 1; }

        try {
            map.setPaintProperty(LM_FOCUS_GLOW_OUTER, 'line-opacity', _focusGlowOpacity);
            map.setPaintProperty(LM_FOCUS_GLOW_INNER, 'line-opacity', Math.min(_focusGlowOpacity + 0.15, 1.0));
        } catch (_) {}

        _focusGlowTimer = requestAnimationFrame(_pulse);
    }
    _focusGlowTimer = requestAnimationFrame(_pulse);
}

function _remove_focus_glow() {
    if (_focusGlowTimer) { cancelAnimationFrame(_focusGlowTimer); _focusGlowTimer = null; }
    try { if (map.getLayer(LM_FOCUS_GLOW_INNER)) map.removeLayer(LM_FOCUS_GLOW_INNER); } catch (_) {}
    try { if (map.getLayer(LM_FOCUS_GLOW_OUTER)) map.removeLayer(LM_FOCUS_GLOW_OUTER); } catch (_) {}
    try { if (map.getSource(LM_FOCUS_SOURCE)) map.removeSource(LM_FOCUS_SOURCE); } catch (_) {}
}

// ── Alert Focus Segment ──────────────────────────────────────────────────────

function _get_station_for_alert(feature) {
    var geom = feature?.geometry;
    if (!geom) return null;
    try {
        return alert_helpers.get_best_wsr88d_radar(geom);
    } catch (_) { return null; }
}

function _fly_to_alert(feature) {
    try {
        var bbox = turf.bbox(turf.feature(feature.geometry));
        map.fitBounds(bbox, { padding: 60, maxZoom: 8, duration: 800 });
    } catch (_) {}
}

function _fn_arr(val) {
    if (Array.isArray(val) && val[0]) return val[0];
    if (typeof val === 'string') return val;
    return null;
}

// ── Typewriter + Commentary ─────────────────────────────────────────────────

var _typewriterTimer = null;
var _commentaryFadeTimer = null;
var _typewriterFinished = true;
var _onTypewriterFinished = null;

function _stop_typewriter() {
    if (_typewriterTimer) { clearTimeout(_typewriterTimer); _typewriterTimer = null; }
    if (_commentaryFadeTimer) { clearTimeout(_commentaryFadeTimer); _commentaryFadeTimer = null; }
    _typewriterFinished = true;
    _onTypewriterFinished = null;
}

function _show_commentary_box() {
    var $box = $('#lmCommentaryBox');
    $box.removeClass('lmCommentaryBox-fading');
    $box.addClass('lmCommentaryBox-visible');
}

function _hide_commentary_box() {
    var $box = $('#lmCommentaryBox');
    if (!$box.hasClass('lmCommentaryBox-visible')) return;
    $box.addClass('lmCommentaryBox-fading');
    _commentaryFadeTimer = setTimeout(function () {
        $box.removeClass('lmCommentaryBox-visible lmCommentaryBox-fading');
        $('#lmCommentary').text('');
        $('#lmCommentaryStatus').text('');
        _commentaryFadeTimer = null;
    }, 400);
}

var _STATUS_PHRASES = ['ANALYZING RADAR DATA', 'SCANNING WEATHER DATA', 'PROCESSING ALERT DATA', 'READING FORECAST DATA'];

function _typewrite(text, delayMs) {
    _stop_typewriter();
    _typewriterFinished = false;
    var $el = $('#lmCommentary');
    var $status = $('#lmCommentaryStatus');
    if (!$el.length || !text) { _typewriterFinished = true; return; }

    $el.text('').removeClass('lmCommentary-done');
    $status.text(_pick_random(_STATUS_PHRASES));
    _show_commentary_box();

    var idx = 0;
    var baseDelay = 22;
    var queue = text.split('');

    function _tick() {
        if (!_active || idx >= queue.length) {
            if (_typewriterTimer) { clearTimeout(_typewriterTimer); _typewriterTimer = null; }
            $el.addClass('lmCommentary-done');
            $status.text('');
            _typewriterFinished = true;
            if (typeof _onTypewriterFinished === 'function') {
                var cb = _onTypewriterFinished;
                _onTypewriterFinished = null;
                cb();
            }
            return;
        }
        if (idx === 0) $status.text('');
        var ch = queue[idx++];
        $el.text($el.text() + ch);

        var next = baseDelay + Math.random() * 12;
        if (ch === '.' || ch === '!' || ch === '?') next += 180;
        else if (ch === ',') next += 80;
        _typewriterTimer = setTimeout(_tick, next);
    }

    _typewriterTimer = setTimeout(_tick, delayMs || 800);
}

var DWELL_AFTER_TYPING_MS = 4000;

function _wait_for_typewriter_then(callback) {
    if (_typewriterFinished) {
        _trackAlertTimer(callback, DWELL_AFTER_TYPING_MS);
    } else {
        _onTypewriterFinished = function () {
            _trackAlertTimer(callback, DWELL_AFTER_TYPING_MS);
        };
    }
}

function _time_of_day() {
    var h = new Date().getHours();
    if (h < 6) return 'overnight';
    if (h < 12) return 'this morning';
    if (h < 17) return 'this afternoon';
    if (h < 21) return 'this evening';
    return 'tonight';
}

function _generate_alert_commentary(feature, motion, city) {
    var p = feature.properties || {};
    var event = p.event || 'Alert';
    var params = p.parameters ? (typeof p.parameters === 'string' ? JSON.parse(p.parameters) : p.parameters) : {};
    var desc = (p.description || '').toUpperCase();
    var area = p.areaDesc || 'the warned area';
    var wind = _fn_arr(params.maxWindGust);
    var hail = _fn_arr(params.maxHailSize);
    var hailNum = parseFloat(hail);
    var tod = _time_of_day();

    var lines = [];

    if (event === 'Tornado Emergency' || event === 'PDS Tornado Warning') {
        lines.push(_pick_random([
            'We are tracking a PARTICULARLY DANGEROUS SITUATION — a confirmed, large tornado is on the ground near ' + area + '.',
            'This is an ongoing TORNADO EMERGENCY for ' + area + '. A violent, life-threatening tornado has been confirmed.',
            'An extremely dangerous tornado emergency is unfolding across ' + area + ' right now.',
            'This is as serious as it gets — a tornado emergency has been declared for ' + area + '. A large and destructive tornado is on the ground.',
            'The National Weather Service has issued a TORNADO EMERGENCY for ' + area + '. This is a life-threatening situation happening right now.',
            'A catastrophic tornado is confirmed near ' + area + ' ' + tod + '. This is a rare tornado emergency — the highest urgency warning the NWS can issue.',
            'We\'re in a TORNADO EMERGENCY for ' + area + '. This means a violent tornado has been confirmed and is producing significant damage.'
        ]));
        lines.push(_pick_random([
            'If you are in the path of this storm, take shelter immediately in the lowest interior room of a sturdy building.',
            'Get underground or to the lowest floor NOW. Cover your head and stay away from all windows.',
            'This tornado is capable of leveling homes. Seek the strongest shelter available and protect yourself immediately.',
            'This is a life-or-death situation. Get to your tornado safe room right now — basement, storm cellar, or the most interior room on the lowest floor.',
            'Do not try to outrun this tornado. If you are in a mobile home, get out and find a more substantial structure or lie flat in a ditch.',
            'Protect yourself with heavy blankets or a mattress. Get under something sturdy and cover your head. Every second counts.'
        ]));
        if (motion) {
            lines.push(_pick_random([
                'This storm is moving ' + _bearing_to_cardinal(motion.bearingDeg) + ' at ' + motion.speedMph + ' mph.',
                'The tornado is tracking ' + _bearing_to_cardinal(motion.bearingDeg) + ' at ' + motion.speedMph + ' miles per hour.',
                'Radar shows this violent storm pushing ' + _bearing_to_cardinal(motion.bearingDeg) + ' at ' + motion.speedMph + ' mph — it\'s covering ground fast.'
            ]));
            if (city) {
                var cityDist = _city_distance_miles(motion, city);
                var etaMin = _city_eta_minutes(cityDist, motion.speedMph);
                if (etaMin && etaMin > 0 && etaMin < 120) {
                    lines.push(_pick_random([
                        'At this speed, the storm could impact ' + city.name + ' in approximately ' + etaMin + ' minutes.',
                        city.name + ' is roughly ' + Math.round(cityDist) + ' miles in the storm\'s path — estimated impact in about ' + etaMin + ' minutes.',
                        'At this pace, ' + city.name + ' has about ' + etaMin + ' minutes before the storm arrives. Take shelter now if you\'re in that area.',
                        city.name + ' is directly downstream — approximately ' + etaMin + ' minutes out at current storm speed.',
                        'If you\'re in ' + city.name + ', you have roughly ' + etaMin + ' minutes. Do not wait — act now.'
                    ]));
                }
            }
        }
    } else if (event === 'Tornado Warning') {
        var torSrc = _fn_arr(params.tornadoDetection) || '';
        if (torSrc.toLowerCase().includes('observed') || desc.includes('CONFIRMED')) {
            lines.push(_pick_random([
                'A tornado has been spotted on the ground near ' + area + '. This storm is confirmed dangerous and on the move.',
                'Storm spotters have confirmed a tornado in ' + area + '. This is not a drill — take action now.',
                'We\'re looking at a confirmed tornado touching down in ' + area + ' ' + tod + '.',
                'A tornado is on the ground and has been visually confirmed near ' + area + '. This is an extremely dangerous storm.',
                'Eyewitnesses have reported a tornado in ' + area + ' ' + tod + '. This confirmation means the threat is real and immediate.',
                'A tornado has been confirmed near ' + area + ' by trained spotters. If you are anywhere near this storm, seek shelter immediately.',
                'This is not radar-only — a tornado has been confirmed on the ground near ' + area + '. Get to safety right now.'
            ]));
        } else if (torSrc.toLowerCase().includes('radar indicated') || desc.includes('RADAR INDICATED')) {
            lines.push(_pick_random([
                'Doppler radar is showing strong, persistent rotation in a thunderstorm threatening ' + area + '. A tornado is likely developing.',
                'We\'re picking up tight rotation on radar over ' + area + '. This storm has the hallmarks of a tornado producer.',
                'Radar data reveals a well-defined mesocyclone bearing down on ' + area + '. Tornado formation is imminent or already occurring.',
                'Strong rotational signatures on Doppler radar indicate a likely tornado embedded in this storm over ' + area + '.',
                'The radar presentation over ' + area + ' is textbook for tornado development — a tight couplet on velocity and strong inbound-outbound signatures.',
                'Dual-pol radar data suggests debris may already be lofted near ' + area + '. This storm is very likely producing a tornado right now.',
                'We\'re seeing a pronounced hook echo and tight velocity couplet on the radar targeting ' + area + '. Tornado development is highly probable.'
            ]));
        } else {
            lines.push(_pick_random([
                'A tornado warning has been issued for ' + area + ' ' + tod + '. Conditions are ripe for tornado development with this storm.',
                'The National Weather Service has activated a tornado warning covering ' + area + '. This storm needs to be taken seriously.',
                'We\'re monitoring a tornado-warned storm moving through ' + area + ' ' + tod + '.',
                'A tornado warning is now in effect for ' + area + '. The environment is favorable for tornado development, and this storm is rotating.',
                'The NWS has put ' + area + ' under a tornado warning ' + tod + '. Even without confirmation yet, treat this as a real threat.',
                'Breaking in with a tornado warning for ' + area + '. The atmosphere ' + tod + ' is volatile and this storm is showing rotation.'
            ]));
        }
        lines.push(_pick_random([
            'Get to an interior room on the lowest floor, away from windows. Put as many walls between you and the outside as possible.',
            'If you\'re in the path of this storm, shelter immediately — interior room, lowest floor, away from glass.',
            'Don\'t wait to see or hear it. Move to your safe room now and protect your head with pillows or a mattress.',
            'Your safest option is a basement or storm shelter. If neither is available, go to a small interior room — closet or bathroom — on the lowest floor.',
            'Grab your shoes and a helmet if you have one, and get to your safe room. Tornadoes can strike with almost no lead time.',
            'If you\'re in a mobile home, leave it now and get to a sturdier structure or a designated storm shelter. Mobile homes offer no protection from tornadoes.',
            'Take cover immediately. Interior walls, away from windows and exterior doors. Protect your head and neck.'
        ]));
        if (wind || hail) {
            var extras = [];
            if (wind) extras.push('wind gusts up to ' + wind);
            if (hail && !isNaN(hailNum) && hailNum > 0) extras.push(hailNum.toFixed(2) + '" hail');
            lines.push(_pick_random([
                'Beyond the tornado threat, this storm is packing ' + extras.join(' and ') + '.',
                'In addition to the tornado risk, expect ' + extras.join(' along with ') + ' from this supercell.',
                'This isn\'t just a tornado threat — the storm is also producing ' + extras.join(' and ') + '.',
                'Even outside the tornado path, this storm carries ' + extras.join(' and ') + '. Stay sheltered.'
            ]));
        }
        if (motion) {
            lines.push(_pick_random([
                'This storm is tracking ' + _bearing_to_cardinal(motion.bearingDeg) + ' at ' + motion.speedMph + ' mph.',
                'The storm is moving ' + _bearing_to_cardinal(motion.bearingDeg) + ' at ' + motion.speedMph + ' miles per hour.',
                'Radar shows this cell pushing ' + _bearing_to_cardinal(motion.bearingDeg) + ' at roughly ' + motion.speedMph + ' mph.',
                'The supercell is progressing ' + _bearing_to_cardinal(motion.bearingDeg) + ' at ' + motion.speedMph + ' mph — keep that direction in mind if you\'re downstream.',
                'Storm motion is ' + _bearing_to_cardinal(motion.bearingDeg) + ' at ' + motion.speedMph + ' mph. Anyone in that path should be in shelter already.'
            ]));
            if (city) {
                var cityDist = _city_distance_miles(motion, city);
                var etaMin = _city_eta_minutes(cityDist, motion.speedMph);
                if (etaMin && etaMin > 0 && etaMin < 120) {
                    lines.push(_pick_random([
                        'At current speed, this storm could reach ' + city.name + ' in approximately ' + etaMin + ' minutes.',
                        city.name + ' is about ' + Math.round(cityDist) + ' miles downrange — roughly ' + etaMin + ' minutes away at this pace.',
                        'The projected path puts ' + city.name + ' in the crosshairs in roughly ' + etaMin + ' minutes.',
                        'Residents of ' + city.name + ' should prepare now — the storm is estimated to arrive in about ' + etaMin + ' minutes.',
                        city.name + ' is in the direct path. At ' + motion.speedMph + ' mph, that\'s approximately ' + etaMin + ' minutes of lead time.',
                        'If you\'re in or near ' + city.name + ', you have roughly ' + etaMin + ' minutes to get to shelter. Don\'t delay.'
                    ]));
                }
            }
        }
    } else if (event === 'Severe Thunderstorm Warning') {
        var torPossible = false;
        var det = _fn_arr(params.tornadoDetection);
        if (det && det.toLowerCase().includes('possible')) torPossible = true;
        if (desc.includes('TORNADO POSSIBLE')) torPossible = true;

        lines.push(_pick_random([
            'A powerful thunderstorm is pushing through ' + area + ' ' + tod + ', and the NWS has issued a severe thunderstorm warning.',
            'Severe weather is impacting ' + area + ' right now — a strong thunderstorm is moving through the area.',
            'The National Weather Service is tracking a dangerous thunderstorm affecting ' + area + ' ' + tod + '.',
            'We\'ve got a severe thunderstorm warning in effect for ' + area + '. This storm means business ' + tod + '.',
            'A severe-warned storm is hammering ' + area + ' right now. Let\'s take a closer look at the threats.',
            'Heads up for ' + area + ' — the NWS has issued a severe thunderstorm warning as a potent cell moves through the region ' + tod + '.',
            'A destructive thunderstorm is bearing down on ' + area + '. This one has caught the attention of the NWS for good reason.'
        ]));

        if (wind || (hail && !isNaN(hailNum) && hailNum > 0)) {
            var threats = [];
            if (wind) threats.push(_pick_random([
                'destructive winds gusting to ' + wind,
                'wind gusts reaching ' + wind,
                'straight-line winds up to ' + wind,
                'damaging outflow winds near ' + wind,
                'powerful downdraft winds approaching ' + wind
            ]));
            if (hail && !isNaN(hailNum) && hailNum > 0) {
                if (hailNum >= 2.0) threats.push(_pick_random([
                    'baseball-sized hail up to ' + hailNum.toFixed(2) + '"',
                    'enormous hailstones reaching ' + hailNum.toFixed(2) + '" in diameter',
                    'destructive ' + hailNum.toFixed(2) + '" hail — that\'s baseball size'
                ]));
                else if (hailNum >= 1.75) threats.push(_pick_random([
                    'large hail up to ' + hailNum.toFixed(2) + '" — nearly baseball size',
                    'significant hail at ' + hailNum.toFixed(2) + '", approaching baseball territory',
                    hailNum.toFixed(2) + '" hail — large enough to cause serious vehicle damage'
                ]));
                else if (hailNum >= 1.0) threats.push(_pick_random([
                    'golf ball to quarter-sized hail at ' + hailNum.toFixed(2) + '"',
                    'sizeable hailstones up to ' + hailNum.toFixed(2) + '"',
                    hailNum.toFixed(2) + '" hail — enough to dent cars and crack windshields'
                ]));
                else threats.push('hail up to ' + hailNum.toFixed(2) + '" in diameter');
            }
            lines.push(_pick_random([
                'This storm is capable of producing ' + threats.join(' along with ') + '.',
                'Primary threats with this cell include ' + threats.join(' and ') + '.',
                'Expect ' + threats.join(' and ') + ' with this storm.',
                'The biggest concerns here are ' + threats.join(' and ') + '.',
                'This cell is packing ' + threats.join(' along with ') + '. Not a storm you want to be caught outside in.'
            ]));
        }

        if (hailNum >= 2.0) {
            lines.push(_pick_random([
                'Hail at that size can punch through roofs, shatter car windows, and cause serious injury if you\'re caught outside.',
                'This is life-threatening hail. Vehicles left exposed will sustain major damage.',
                'Baseball-sized hail is a genuine danger — get vehicles under cover and stay indoors.',
                'Hailstones this large can total a car in seconds and break through skylights. This is not something to watch from the porch.',
                'We\'re talking about ice the size of baseballs falling from the sky. If you have a garage, use it. If you don\'t, stay far from windows.',
                'At this size, hail becomes a projectile. It can injure or kill — do not go outside to observe this storm.'
            ]));
        }

        if (torPossible) {
            lines.push(_pick_random([
                'Notably, this storm carries a tornado possible tag. Be prepared to shelter if a tornado warning is issued.',
                'The NWS has flagged this storm for possible tornado development. Stay alert for an upgrade to a tornado warning.',
                'There\'s a tornado threat embedded in this storm. Keep a close eye on it and be ready to take cover.',
                'This one also has a tornado possible flag — meaning the rotation is borderline. An upgrade to a tornado warning could come at any moment.',
                'Don\'t ignore the tornado possible tag on this warning. It means the storm is showing enough rotation that forecasters are concerned.',
                'The tornado possible tag means this storm has the ingredients to spin up a tornado. Have your safe room plan ready to go.'
            ]));
        } else {
            lines.push(_pick_random([
                'Stay inside and away from windows until the storm clears your area.',
                'If you\'re outdoors, get inside a solid structure. If driving, pull off the road and keep your seatbelt on.',
                'The best protection is to be inside a well-built structure away from exterior walls and glass.',
                'Keep away from windows and glass doors. The biggest threat from these storms is flying debris and sudden wind gusts.',
                'If you\'re on the road, don\'t park under an overpass — find a sturdy building to shelter in. Overpasses actually funnel wind.',
                'Wait for this one to pass before heading back outside. These storms can produce sudden downbursts with very little lead time.'
            ]));
        }
    } else if (event === 'Flash Flood Warning') {
        lines.push(_pick_random([
            'Flash flooding is occurring or developing rapidly across ' + area + ' ' + tod + '.',
            'Dangerous flash flooding is threatening ' + area + '. Water levels are rising fast.',
            'The NWS has issued a flash flood warning for ' + area + ' as heavy rain continues to saturate the region.',
            'We\'re tracking a flash flood emergency across ' + area + ' — water is rising rapidly and conditions are deteriorating.',
            'Heavy rainfall has overwhelmed drainage across ' + area + ', and flash flooding is now in progress.',
            'A flash flood warning is active for ' + area + ' ' + tod + '. Rainfall rates have exceeded what the ground can absorb.',
            'Flooding conditions are unfolding quickly in ' + area + '. Streams, creeks, and urban areas are especially vulnerable right now.'
        ]));
        var dmg = _fn_arr(params.flashFloodDamageThreat);
        if (dmg && dmg.toUpperCase() === 'CATASTROPHIC') {
            lines.push(_pick_random([
                'This is a CATASTROPHIC flooding event. Expect life-threatening inundation of roads, structures, and low-lying areas.',
                'The damage threat is rated CATASTROPHIC — this is as serious as flash flooding gets. Evacuate if told to do so.',
                'We\'re looking at a rare catastrophic flash flood. Rescue operations may become necessary.',
                'The NWS is calling this CATASTROPHIC. That\'s the highest damage tier — expect impassable roads, structural flooding, and swift-water rescues.',
                'A catastrophic flash flood event is underway. This has the potential to be a historic flood for ' + area + '.',
                'When the NWS uses the word catastrophic, they\'re not exaggerating. This is an extremely dangerous and potentially deadly flood situation.'
            ]));
        } else if (dmg && dmg.toUpperCase() === 'CONSIDERABLE') {
            lines.push(_pick_random([
                'Significant flooding of roadways and low-lying areas is expected. Some structures near waterways could sustain damage.',
                'The damage threat is considerable — creeks and streams are overflowing and roads are becoming impassable.',
                'This is a serious flood event. Water is exceeding bank-full levels across the warned area.',
                'With a considerable damage threat, expect water in places it doesn\'t normally reach. Low-water crossings will be completely submerged.',
                'Roads and underpasses across the warned area are likely already flooding. This is a step above the typical flash flood warning.'
            ]));
        }
        lines.push(_pick_random([
            'Never drive through flooded roadways. Just six inches of moving water can knock you off your feet, and two feet can float a vehicle.',
            'Turn around, don\'t drown. More deaths occur from flooding than any other severe weather hazard.',
            'Move to higher ground if water is rising near you. Do not attempt to walk or drive through flood waters.',
            'Half of all flash flood fatalities involve vehicles. If you encounter water on the road, turn around immediately.',
            'Flooding kills more people each year than tornadoes, hurricanes, or lightning. Take every flash flood warning seriously.',
            'If water is rising around your home, move to the highest floor. Do not go into the attic without a way to escape through the roof.',
            'Stay off roads after dark in flooded areas — you cannot gauge water depth at night. Many fatal flood drownings happen after sunset.'
        ]));
    } else if (event === 'Evacuation - Immediate') {
        lines.push(_pick_random([
            'An IMMEDIATE EVACUATION order has been issued for ' + area + '. This is not a drill — leave the area now.',
            'Emergency management has ordered an immediate evacuation of ' + area + '. Life-threatening conditions are present or imminent.',
            'A mandatory evacuation is in effect for ' + area + '. Residents must leave immediately for their own safety.',
            'This is an emergency evacuation order for ' + area + '. Drop everything and get out — your safety depends on immediate action.',
            'Officials have ordered everyone in ' + area + ' to evacuate immediately. Life-threatening conditions are expected to escalate rapidly.',
            'An urgent evacuation order has been activated for ' + area + '. Do not wait for further updates — leave now.'
        ]));
        if (desc.includes('FLOOD') || desc.includes('DAM') || desc.includes('LEVEE') || desc.includes('WATER')) {
            lines.push(_pick_random([
                'This evacuation is driven by dangerous flooding conditions. Rising water levels pose an imminent threat to life and property.',
                'Floodwaters are threatening the area. Roads may become impassable at any moment — do not delay your departure.',
                'Water is rising rapidly in the evacuation zone. Get to higher ground and away from waterways immediately.',
                'A dam, levee, or waterway is threatening to overflow or has already breached. The resulting flood surge could be swift and deadly.',
                'Floodwaters are extremely deceptive — they move faster and carry more force than they appear. Evacuate to high ground now.',
                'The water threat in this area is escalating. Infrastructure failures could send a wall of water through the evacuation zone at any time.'
            ]));
        } else if (desc.includes('FIRE') || desc.includes('WILDFIRE')) {
            lines.push(_pick_random([
                'A fast-moving wildfire is threatening the area. Flames and smoke can overtake roads quickly — evacuate now.',
                'Fire conditions are extreme and the threat to life is imminent. Follow your evacuation route without delay.',
                'This fire is moving rapidly. Grab essential items and leave immediately — do not wait for further notice.',
                'Wind-driven fire can travel faster than you can drive on congested roads. Do not underestimate how quickly this fire can spread.',
                'Smoke alone can be deadly. Even if you can\'t see flames, evacuate immediately — toxic fumes can incapacitate you in minutes.',
                'Embers from this fire can travel miles ahead of the main front. The entire area is at risk.'
            ]));
        } else {
            lines.push(_pick_random([
                'Conditions in the area are deteriorating rapidly. Follow instructions from local emergency management.',
                'The situation is considered life-threatening. Evacuate immediately using designated routes.',
                'Do not ignore this order. Gather your family, essential medications, and important documents, and leave the area now.',
                'Local authorities have determined that remaining in the area poses an immediate danger to your life. Comply with this evacuation order.',
                'Time is critical. Conditions may prevent evacuation if you delay. Leave while routes are still passable.',
                'This evacuation is mandatory — meaning officials believe the threat is severe enough that staying could result in death or serious injury.'
            ]));
        }
        lines.push(_pick_random([
            'If you need shelter, contact local emergency services or tune to local media for evacuation routes and shelter locations.',
            'Take phone chargers, medications, pets, and important documents with you. Check on your neighbors before you leave.',
            'Follow designated evacuation routes. Do not take shortcuts — they may be blocked or dangerous.',
            'Head to the nearest evacuation shelter. If you need transportation assistance, call 911 or your local emergency number.',
            'Bring a go-bag with essentials: water, medications, phone charger, ID, cash, and a change of clothes. Help elderly or disabled neighbors if you can.',
            'Lock your home, turn off utilities if you have time, and take your evacuation route. Traffic will be heavy — stay patient and stay on route.'
        ]));
    }

    return lines.join(' ');
}

var _SPC_RISK_NAMES = {
    'TSTM': 'Thunderstorm', 'MRGL': 'Marginal', 'SLGT': 'Slight',
    'ENH': 'Enhanced', 'MDT': 'Moderate', 'HIGH': 'High'
};
var _SPC_RISK_ORDER = ['HIGH', 'MDT', 'ENH', 'SLGT', 'MRGL', 'TSTM'];

function _extract_spc_stats(features) {
    var maxPct = 0;
    var hasHatched = false;
    for (var i = 0; i < features.length; i++) {
        var lbl = String(features[i]?.properties?.label || '');
        var n = parseInt(lbl);
        if (!isNaN(n) && n > maxPct) maxPct = n;
        if (lbl.toLowerCase().indexOf('hatched') !== -1 || String(features[i]?.properties?.label2 || '').toLowerCase().indexOf('hatched') !== -1) hasHatched = true;
    }
    return { maxPct: maxPct, hasHatched: hasHatched };
}

function _generate_spc_commentary(hazard, geojson) {
    var features = geojson?.features || [];
    var tod = _time_of_day();
    var lines = [];

    if (hazard === 'categorical') {
        var highest = null;
        for (var i = 0; i < features.length; i++) {
            var lbl = String(features[i]?.properties?.label || '').toUpperCase().trim();
            for (var r = 0; r < _SPC_RISK_ORDER.length; r++) {
                if (lbl === _SPC_RISK_ORDER[r] || lbl.indexOf(_SPC_RISK_ORDER[r]) !== -1) {
                    if (!highest || _SPC_RISK_ORDER.indexOf(_SPC_RISK_ORDER[r]) < _SPC_RISK_ORDER.indexOf(highest)) {
                        highest = _SPC_RISK_ORDER[r];
                    }
                    break;
                }
            }
        }

        if (highest === 'HIGH') {
            lines.push(_pick_random([
                'The SPC has issued a rare HIGH RISK — only issued a handful of times each year. All modes of severe weather are expected, including violent tornadoes.',
                'This is one of the most dangerous days on the calendar. A HIGH RISK means widespread, significant severe weather is virtually certain.',
                'A HIGH RISK day is as serious as it gets. The SPC is expecting a major severe weather outbreak with life-threatening hazards across the risk area.',
                'We are looking at a HIGH RISK from the SPC ' + tod + '. This is an exceptionally rare outlook level that signals a high-end, potentially historic severe weather event.',
                'The Storm Prediction Center has pulled the trigger on a HIGH RISK. This is reserved for the most extreme setups — major tornado outbreaks, widespread destructive winds, and giant hail.',
                'A HIGH RISK is staring us in the face ' + tod + '. The atmosphere is loaded with energy — extreme instability, powerful shear, and a volatile synoptic setup.'
            ]));
            var highContext = _pick_random([
                'The upper-level jet stream is providing exceptional wind shear, and surface moisture is off the charts.',
                'A powerful low-pressure system and associated warm front are creating explosive conditions across the risk area.',
                'All the ingredients are aligned — a vigorous shortwave, rich Gulf moisture, and a strongly sheared environment.',
                '', ''
            ]);
            if (highContext) lines.push(highContext);
            lines.push(_pick_random([
                'Everyone in the highlighted area should have shelter plans ready and multiple ways to receive warnings.',
                'This is a day to stay vigilant from start to finish. Tornadoes, destructive winds, and very large hail are all on the table.',
                'If you live in the risk area, charge your devices, know your safe room, and stay glued to weather updates.',
                'Please take this seriously — a HIGH RISK day means you need a plan, a shelter, and situational awareness from now until the threat passes.',
                'Storm chasers will be out in force, but for everyone else, the safest place is indoors with a way to receive real-time warnings.',
                'This is not a day to be caught off-guard. Violent tornadoes, destructive hail, and widespread damaging winds are all expected.'
            ]));
        } else if (highest === 'MDT') {
            lines.push(_pick_random([
                'A MODERATE RISK is on the board ' + tod + '. The SPC expects widespread severe storms, and significant events are likely.',
                'The SPC has elevated the outlook to MODERATE — a clear signal that a noteworthy severe weather event is unfolding.',
                'We\'re seeing a Moderate risk from the SPC, which tells us the atmosphere is primed for a serious round of severe weather.',
                'A Moderate risk has been issued ' + tod + ', and historically, these days produce some of the most impactful severe weather events of the year.',
                'The SPC is highlighting a MODERATE RISK — this tier is only issued a few dozen times per year. The threat level is significant.',
                'We\'re dealing with a Moderate risk ' + tod + '. The ingredients are coming together for a substantial severe weather event across the highlighted area.',
                'A MODERATE RISK from the Storm Prediction Center — the atmosphere is ripe with strong shear, ample moisture, and a forcing mechanism to kick things off.'
            ]));
            var mdtContext = _pick_random([
                'A potent shortwave trough and rich low-level moisture are the key players in this setup.',
                'Strong deep-layer shear and an unstable air mass will fuel organized, long-lived severe storms.',
                '', ''
            ]);
            if (mdtContext) lines.push(mdtContext);
            lines.push(_pick_random([
                'People in the risk area should closely monitor conditions and have a shelter plan activated.',
                'This level of risk means forecasters are highly confident in a significant severe event. Stay weather-aware.',
                'Don\'t underestimate a Moderate risk day — some of the worst outbreaks in history have occurred under this category.',
                'If you\'re in the risk area, now is the time to prepare. Know where your shelter is and keep your phone charged for alerts.',
                'With a Moderate risk in play, expect storm reports to come in fast as the day progresses. Have multiple sources for weather information.',
                'Emergency managers in the affected area should be on high alert. This has the potential to be a high-impact event.'
            ]));
        } else if (highest === 'ENH') {
            lines.push(_pick_random([
                'An ENHANCED RISK is highlighted for today, meaning numerous severe storms are expected with the potential for a few significant ones.',
                'The SPC outlook shows an Enhanced risk ' + tod + '. This is a step above Slight, and severe weather is becoming increasingly likely.',
                'We\'re tracking an Enhanced risk from the Storm Prediction Center. Multiple rounds of organized severe storms could impact the region.',
                'An Enhanced risk is in play ' + tod + ' — the SPC sees enough ingredients for a concentrated area of severe thunderstorms.',
                'The Day 1 outlook has been upgraded to Enhanced. Forecasters have growing confidence in a more organized severe weather event.',
                'We\'re looking at an ENHANCED RISK across the outlook area. Surface boundaries and upper-level energy are coming together to support widespread severe storms.',
                'An Enhanced risk from the SPC means we should see a noticeable step up in storm coverage and intensity compared to a Slight risk day.'
            ]));
            lines.push(_pick_random([
                'Now is a good time to review your severe weather plan and know where your nearest shelter is.',
                'Keep an eye on radar through the day — storms could ramp up quickly once they fire.',
                'Have a way to receive warnings even while sleeping, as threats may persist into the night.',
                'Stay tuned for mesoscale discussions and potential watch issuances from the SPC as the day progresses.',
                'If you have outdoor plans in the risk area, consider flexible alternatives. Storms could develop rapidly.',
                'This is the kind of day where you want your weather radio on and your phone alerts enabled.'
            ]));
        } else if (highest === 'SLGT') {
            lines.push(_pick_random([
                'The Day 1 outlook features a SLIGHT RISK, which means scattered severe storms are possible ' + tod + ' with isolated tornadoes, hail, and damaging winds.',
                'A Slight risk is in play — not a guarantee of severe weather in any one spot, but enough ingredients are present for organized storms to produce hazards.',
                'The SPC has placed parts of the country under a Slight risk. A few storms could turn severe as the day progresses.',
                'We\'re tracking a Slight risk ' + tod + '. While it\'s the middle tier, a Slight risk can still produce a few dangerous storms — don\'t let the name fool you.',
                'A SLIGHT RISK is on the map, and while it doesn\'t scream catastrophe, it does mean some storms will pack a punch.',
                'The SPC has highlighted a Slight risk for portions of the region. Isolated to scattered severe storms are expected, with all hazard types possible.',
                'A Slight risk day means scattered severe weather — a handful of storms could produce damaging winds, hail, or even a brief tornado.'
            ]));
        } else if (highest === 'MRGL') {
            lines.push(_pick_random([
                'A MARGINAL RISK is outlined for today — the lowest tier of severe risk. An isolated storm or two could briefly reach severe limits.',
                'We\'re looking at a Marginal risk, meaning the severe weather threat is low but not zero. A stray damaging gust or hail report is possible.',
                'The SPC has painted a Marginal risk area on the outlook. Confidence in widespread severe weather is low, but stay aware if storms develop near you.',
                'A Marginal risk is on the board ' + tod + ' — think of it as a heads-up that a storm or two might get rowdy, but nothing widespread.',
                'The Day 1 outlook shows a Marginal risk. This is the SPC\'s way of saying the environment marginally supports a severe storm, but the odds are low.',
                'We\'re at the Marginal level on the SPC outlook — the lowest rung of severe risk. An isolated gusty storm or small hail event is about the extent of it.',
                'A Marginal risk is highlighted, but most people in the risk area probably won\'t see severe weather. It\'s just worth having on your radar.'
            ]));
        } else {
            lines.push(_pick_random([
                'The Day 1 outlook is showing general thunderstorm coverage, but no organized severe risk has been identified by the SPC.',
                'No categorical severe risk is outlined today. Any thunderstorms that develop should remain below severe criteria.',
                'It\'s a relatively quiet setup on the convective outlook. The SPC doesn\'t see the ingredients for widespread severe weather today.',
                'The SPC outlook is all green ' + tod + ' — general thunderstorm areas only. The severe weather threat is essentially zero.',
                'Quiet day on the convective outlook. No severe risk areas have been highlighted by the Storm Prediction Center.',
                'The atmosphere is relatively stable ' + tod + ' with no organized severe potential. Enjoy the calm while it lasts.',
                'Nothing alarming on the Day 1 outlook — the SPC sees no real setup for severe weather across the lower 48 right now.'
            ]));
        }
    } else if (hazard === 'tornado') {
        var ts = _extract_spc_stats(features);
        if (ts.maxPct >= 30) {
            lines.push(_pick_random([
                'The tornado outlook is screaming danger — a ' + ts.maxPct + '% probability area signals a full-blown tornado outbreak is expected.',
                'At ' + ts.maxPct + '%, this is an exceptionally high tornado probability. Numerous strong to violent tornadoes are anticipated.',
                'This ' + ts.maxPct + '% tornado probability is historic-level. The atmosphere is loaded for a major outbreak.',
                'We are in rare territory with a ' + ts.maxPct + '% tornado probability — this is the kind of setup that produces long-track, violent tornadoes.',
                'The SPC has drawn a ' + ts.maxPct + '% tornado contour, and that is about as alarming as it gets. Multiple significant tornadoes are expected.',
                'At ' + ts.maxPct + '% tornado probability, the SPC is telling us to expect a prolific tornado event. EF3 or stronger tornadoes are a real possibility ' + tod + '.'
            ]));
            var torContext = _pick_random([
                'The low-level jet is screaming, and hodographs are massive — textbook setup for long-track supercells.',
                'Extreme wind shear and a volatile warm sector are fueling this outbreak potential.',
                '', ''
            ]);
            if (torContext) lines.push(torContext);
        } else if (ts.maxPct >= 15) {
            lines.push(_pick_random([
                'A ' + ts.maxPct + '% tornado probability area is drawn on the outlook. Multiple tornadoes, including potentially strong ones, are expected.',
                'At ' + ts.maxPct + '%, the tornado threat is elevated well above average. Supercells with tornado potential will likely develop ' + tod + '.',
                'The SPC has highlighted a notable ' + ts.maxPct + '% tornado probability zone. Several tornadoes are possible, and some could be significant.',
                'A ' + ts.maxPct + '% tornado probability is noteworthy — this suggests discrete supercells capable of producing strong tornadoes within the highlighted area.',
                'The ' + ts.maxPct + '% tornado contour tells us the mesocyclone environment is favorable. Rotating storms are expected to develop ' + tod + '.',
                'We\'re looking at ' + ts.maxPct + '% tornado probabilities, which is a clear signal that storm chasers and emergency managers will be active today.',
                'At ' + ts.maxPct + '%, the tornado potential is significant. The low-level jet and shear profiles are strongly supportive of tornadic supercells.'
            ]));
        } else if (ts.maxPct >= 5) {
            lines.push(_pick_random([
                'A ' + ts.maxPct + '% tornado probability is in play. The environment supports supercell development with embedded tornado risk.',
                'The tornado outlook shows a ' + ts.maxPct + '% zone — enough to warrant close attention. Isolated tornadoes are possible with the strongest storms.',
                'We\'re seeing ' + ts.maxPct + '% tornado probabilities on the Day 1 outlook. Any storm that can sustain rotation will bear watching.',
                'A ' + ts.maxPct + '% tornado probability area is outlined ' + tod + '. The hodographs and wind profiles suggest a window for brief tornadoes.',
                'The SPC is showing ' + ts.maxPct + '% for tornado — not extreme, but definitely enough to have your weather radio on and shelter plan in mind.',
                'At ' + ts.maxPct + '% tornado probabilities, we could see a few isolated tornadoes if cells can tap into the low-level shear.'
            ]));
        } else if (ts.maxPct >= 2) {
            lines.push(_pick_random([
                'A ' + ts.maxPct + '% tornado probability is on the map — low, but not negligible. Brief, weak tornadoes can still cause damage and injury.',
                'The tornado risk sits at ' + ts.maxPct + '%, which is on the lower end. Still, it only takes one tornado to ruin someone\'s day.',
                'Even at ' + ts.maxPct + '%, don\'t let your guard down. Tornadoes from low-probability setups can still be deadly if you\'re not prepared.',
                'A ' + ts.maxPct + '% tornado signal is on the outlook. It\'s a low-end threat, but a brief spin-up tornado can\'t be ruled out with the stronger cells.',
                'We\'re looking at ' + ts.maxPct + '% tornado probabilities — relatively low, but these are the kind of setups that produce the occasional surprise tornado.',
                'At just ' + ts.maxPct + '%, the tornado threat is conditional, but the ingredients for a brief tornado are present if a storm can get its act together.'
            ]));
        } else if (features.length) {
            lines.push(_pick_random([
                'The SPC has outlined tornado probabilities, though overall confidence in tornado development remains low.',
                'Some tornado potential has been flagged, but the environment isn\'t fully supportive of widespread tornado activity.',
                'There\'s a non-zero tornado signal on the outlook. The risk is marginal, but worth monitoring if storms fire.',
                'A low-end tornado signal is present on the Day 1 outlook. The environment has some supportive ingredients, but the setup isn\'t robust.',
                'The SPC sees a slim chance of tornadoes ' + tod + '. The low-level wind fields are only weakly supportive.',
                'Tornado potential is on the fringe today — the atmosphere could support a brief, weak tornado, but most storms should remain non-tornadic.'
            ]));
        } else {
            lines.push(_pick_random([
                'No significant tornado probabilities are highlighted on the Day 1 outlook at this time.',
                'The tornado outlook is quiet — the ingredients for tornadic storms aren\'t coming together today.',
                'The SPC isn\'t seeing a meaningful tornado threat in the current forecast cycle.',
                'Good news on the tornado front — the Day 1 outlook shows no tornado probability contours today.',
                'No tornado risk to speak of ' + tod + '. The wind profiles don\'t support rotation in any developing storms.',
                'The tornado outlook is clean across the board. The atmosphere isn\'t set up for tornadic activity today.'
            ]));
        }
        if (ts.hasHatched) {
            lines.push(_pick_random([
                'The hatched contour means there\'s a 10%+ chance of EF2 or stronger tornadoes within 25 miles of any point inside it.',
                'Pay close attention to the hatched area — it flags a heightened risk of significant tornadoes, EF2 or stronger.',
                'Where you see hatching, the SPC is signaling that the strongest tornadoes are most likely to occur.',
                'That hatching on the map is critical — it means the SPC expects a 10% or greater chance of significant tornadoes, potentially long-track and violent.',
                'The hatched contour is where the real danger lies. EF2 or stronger tornadoes are expected within 25 miles of any point in that zone.',
                'Notice the hatching — that represents the significant severe parameter. This is where we could see the most intense and potentially deadly tornadoes.'
            ]));
        }
    } else if (hazard === 'wind') {
        var ws = _extract_spc_stats(features);
        if (ws.maxPct >= 30) {
            lines.push(_pick_random([
                'Widespread, destructive winds are expected ' + tod + '. A ' + ws.maxPct + '% probability area means a derecho-level event is possible.',
                'The wind outlook is extremely aggressive at ' + ws.maxPct + '%. Expect widespread tree and power line damage, and potentially worse.',
                'At ' + ws.maxPct + '%, the SPC is forecasting a prolific damaging wind event. Gusts above 75 mph are a genuine possibility.',
                'A ' + ws.maxPct + '% wind probability is exceptionally high. This setup favors a widespread, destructive wind event — possibly a bow echo or derecho.',
                'The SPC has painted a ' + ws.maxPct + '% wind contour ' + tod + ', and that spells trouble. Large-scale damaging winds are virtually certain.',
                'At ' + ws.maxPct + '%, expect a major damaging wind event. Storms will likely organize into a squall line capable of producing hurricane-force gusts.',
                'This ' + ws.maxPct + '% wind probability is as high as it gets. Significant structural damage is possible across a wide swath.'
            ]));
        } else if (ws.maxPct >= 15) {
            lines.push(_pick_random([
                'A significant damaging wind threat is highlighted at ' + ws.maxPct + '%. Storms will be capable of producing widespread 60-80 mph gusts.',
                'The ' + ws.maxPct + '% wind probability tells us to expect numerous reports of damaging winds ' + tod + '. Secure outdoor objects.',
                'With ' + ws.maxPct + '% wind probabilities, clusters of severe storms will likely produce damaging outflow winds across a large area.',
                'The SPC is showing ' + ws.maxPct + '% wind probabilities — organized convective wind damage is a primary threat ' + tod + '.',
                'A ' + ws.maxPct + '% wind probability means damaging straight-line winds will be a major concern. Storms may organize into a fast-moving squall line.',
                'At ' + ws.maxPct + '%, wind damage is going to be the headline story. Trees, power lines, and lightweight structures are all vulnerable.',
                'The ' + ws.maxPct + '% wind contour is broad enough to suggest a widespread damaging wind event rather than just isolated gusts.'
            ]));
        } else if (ws.maxPct >= 5) {
            lines.push(_pick_random([
                'A ' + ws.maxPct + '% damaging wind probability is on the outlook. Isolated to scattered severe gusts are possible with stronger thunderstorms.',
                'Wind damage is in the forecast at ' + ws.maxPct + '%. The main threat will be from storm outflow — gusts over 58 mph.',
                'The ' + ws.maxPct + '% wind zone highlights where thunderstorm downbursts could produce tree damage and localized power outages.',
                'A ' + ws.maxPct + '% wind probability means some storms ' + tod + ' will produce damaging downburst winds. Keep an eye on approaching lines.',
                'We\'re seeing ' + ws.maxPct + '% wind probabilities — enough to warrant attention. Microbursts and strong outflow could produce locally damaging gusts.',
                'The wind threat sits at ' + ws.maxPct + '%. Not the highest we\'ve seen, but still capable of producing some nasty downbursts in the stronger cells.'
            ]));
        } else if (features.length) {
            lines.push(_pick_random([
                'Some wind risk has been identified, though overall confidence in a widespread damaging wind event is low.',
                'A marginal wind threat exists. A stray severe gust is possible but shouldn\'t be a major concern area-wide.',
                'The wind outlook shows limited probabilities. Any severe gusts would be isolated and brief.',
                'A low-end wind signal is present, but the setup doesn\'t favor any organized damaging wind event.',
                'The SPC notes some wind potential ' + tod + ', but it\'s on the fringe — an isolated strong gust at most.',
                'There\'s a marginal wind component to today\'s outlook, but it shouldn\'t be the primary concern.'
            ]));
        } else {
            lines.push(_pick_random([
                'No significant wind damage probabilities are highlighted today.',
                'The Day 1 wind outlook is clean — no meaningful damaging wind signal in the current data.',
                'Winds shouldn\'t be a major player in today\'s weather story.',
                'The wind outlook shows no concerning probabilities ' + tod + '. Gusty thunderstorm winds aren\'t expected.',
                'No damaging wind threat on the board. Storms, if any develop, should produce sub-severe gusts.',
                'The wind picture is quiet — the SPC doesn\'t see the ingredients for significant wind damage today.'
            ]));
        }
        if (ws.hasHatched) {
            lines.push(_pick_random([
                'The hatched area flags a 10%+ chance of 75 mph or stronger gusts — winds that can cause structural damage.',
                'Where you see hatching, the risk of significant wind damage (75+ mph) is elevated. This can rival weak tornado damage.',
                'Inside the hatched zone, hurricane-force gusts above 75 mph are possible. Take these threats seriously.',
                'The hatched contour highlights where 75+ mph gusts are anticipated — winds that can collapse roofs and snap utility poles.',
                'Pay special attention to the hatched area. Winds of 75 mph or greater can cause damage equivalent to an EF1 tornado.',
                'That hatching means business — we\'re talking about the potential for 75+ mph gusts, which is genuinely dangerous and destructive.'
            ]));
        }
    } else if (hazard === 'hail') {
        var hs = _extract_spc_stats(features);
        if (hs.maxPct >= 30) {
            lines.push(_pick_random([
                'A major hail event is expected ' + tod + '. The ' + hs.maxPct + '% probability area signals giant hail — baseball-sized stones or larger are on the table.',
                'At ' + hs.maxPct + '%, the hail outlook is about as alarming as it gets. Expect significant property damage from very large hail.',
                'The SPC is forecasting extreme hail probabilities at ' + hs.maxPct + '%. Supercells will likely produce destructive hailstones exceeding 2 inches.',
                'A ' + hs.maxPct + '% hail probability is a big deal — this kind of setup produces the sort of hail that totals vehicles and punches through roofs.',
                'The SPC has drawn a ' + hs.maxPct + '% hail contour ' + tod + '. Supercell updrafts will be strong enough to loft enormous hailstones.',
                'At ' + hs.maxPct + '%, we are looking at a potentially devastating hail event. Baseball-sized or larger stones are expected with the most intense supercells.',
                'The hail threat is about as serious as it gets at ' + hs.maxPct + '%. Get your vehicles under cover if you can — the damage potential is extreme.'
            ]));
        } else if (hs.maxPct >= 15) {
            lines.push(_pick_random([
                'The hail threat is significant at ' + hs.maxPct + '%. Storms will be capable of producing large to very large hail, enough to damage vehicles and roofs.',
                'A ' + hs.maxPct + '% hail probability means supercells ' + tod + ' could drop golf ball-sized or larger hailstones across the highlighted area.',
                'With ' + hs.maxPct + '% hail probabilities, the SPC expects an active day for large hail reports across this region.',
                'The ' + hs.maxPct + '% hail probability tells us strong updrafts will support large hail production. Quarter to golf ball-sized stones are likely.',
                'At ' + hs.maxPct + '%, hail damage is going to be a primary concern. Keep vehicles sheltered and stay indoors when storms pass overhead.',
                'A ' + hs.maxPct + '% hail probability area is highlighted — the SPC expects these supercells to produce stones large enough to crack windshields.',
                'The hail outlook at ' + hs.maxPct + '% signals an active day. Powerful supercell updrafts will loft significant hailstones across the threat area.'
            ]));
        } else if (hs.maxPct >= 5) {
            lines.push(_pick_random([
                'A ' + hs.maxPct + '% hail probability area is outlined. The strongest storms could produce quarter to golf ball-sized hail.',
                'Hail is a factor ' + tod + ' with ' + hs.maxPct + '% probabilities. Keep vehicles under cover if storms develop in your area.',
                'The ' + hs.maxPct + '% hail zone highlights where updrafts may support stones large enough to dent cars and crack windows.',
                'We\'re seeing ' + hs.maxPct + '% hail probabilities, which means the strongest cells could produce hail in the quarter to ping-pong ball range.',
                'A ' + hs.maxPct + '% hail signal means there\'s enough updraft strength in the forecast to produce large hail. Not catastrophic, but worth watching.',
                'Hail is on the menu at ' + hs.maxPct + '% probability. The strongest supercells could produce stones large enough to damage exposed vehicles.'
            ]));
        } else if (features.length) {
            lines.push(_pick_random([
                'A small hail risk exists, though any large hail reports should be isolated at best.',
                'The hail outlook shows limited probabilities. Marginally severe hail is possible with the most vigorous cells.',
                'Some hail potential is noted, but it\'s not expected to be a widespread concern.',
                'A low-end hail signal is on the outlook. If any hail does occur, it should be on the smaller end of the severe spectrum.',
                'The SPC flags a marginal hail threat ' + tod + '. Penny to nickel-sized hail is about the most we\'d expect.',
                'There\'s a slight chance of marginally severe hail with the strongest storms, but it shouldn\'t be a major issue.'
            ]));
        } else {
            lines.push(_pick_random([
                'No significant hail probabilities are highlighted on today\'s outlook.',
                'The hail outlook is quiet — the environment doesn\'t favor large hail production today.',
                'Large hail isn\'t on the menu for today\'s weather pattern.',
                'The hail outlook is clean ' + tod + '. Storms, if any, shouldn\'t produce significant hail.',
                'No hail worries today — the updraft potential isn\'t strong enough to support large stones.',
                'Hail is a non-factor on today\'s outlook. The environment just doesn\'t support it.'
            ]));
        }
        if (hs.hasHatched) {
            lines.push(_pick_random([
                'Hatching denotes a 10%+ chance of 2-inch or larger hail — stones that size can cause serious injury and total a vehicle.',
                'The hatched area is where the very largest hail is expected. This is a significant threat to anyone caught outside.',
                'Inside the hatched contour, expect the potential for truly destructive hail — 2 inches or larger in diameter.',
                'That hatching means 2-inch-plus hail is expected — we\'re talking baseball-sized stones that can be lethal if you\'re caught outside.',
                'The hatched zone highlights where the most destructive hail is anticipated. Stones of 2 inches or larger can cause catastrophic damage.',
                'Where you see hatching, the SPC expects a 10%+ probability of hail 2 inches or larger. That\'s the kind of hail that makes the news.'
            ]));
        }
    }

    var closing = _pick_random([
        '', '', '', '', '',
        'We\'ll continue to monitor this as the day unfolds.',
        'Stay weather-aware and keep checking back for updates.',
        'We\'ll have more on this as conditions evolve.',
        'Keep it right here — we\'re tracking this around the clock.'
    ]);
    if (closing) lines.push(closing);

    return lines.join(' ');
}

function _generate_conus_commentary() {
    var alerts = _get_active_severe_alerts();
    var torCount = 0;
    var svrCount = 0;
    var ffwCount = 0;
    for (var i = 0; i < alerts.length; i++) {
        var ev = alerts[i]?.properties?.event || '';
        if (TORNADO_EVENTS.includes(ev)) torCount++;
        else if (ev === 'Severe Thunderstorm Warning') svrCount++;
        else if (ev === 'Flash Flood Warning') ffwCount++;
    }
    var total = torCount + svrCount + ffwCount;
    var tod = _time_of_day();

    var lines = [];
    lines.push(_pick_random([
        'Here\'s a look at the national MRMS radar mosaic across the lower 48.',
        'Pulling up the full CONUS view on MRMS composite reflectivity.',
        'Let\'s zoom out to the national radar picture for a broader view of what\'s happening.',
        'Time to take the big-picture view — here\'s the national MRMS radar composite across the continental U.S.',
        'Stepping back to the nationwide radar mosaic ' + tod + '. Let\'s see what\'s going on coast to coast.',
        'Here\'s the full continental view on MRMS reflectivity — a great way to see the overall pattern.',
        'Zooming out to the national scale ' + tod + '. The MRMS composite gives us the best picture of precipitation across the entire country.'
    ]));

    if (total === 0) {
        lines.push(_pick_random([
            'No active severe weather warnings across the nation right now. A relatively calm pattern is in place.',
            'It\'s quiet out there ' + tod + ' — no severe thunderstorm, tornado, or flash flood warnings active.',
            'The warning map is clean at the moment. No severe weather warnings are currently in effect nationwide.',
            'No severe warnings anywhere across the lower 48 right now. A nice break from the action.',
            'The national warning count sits at zero ' + tod + '. The atmosphere is behaving itself for now.',
            'All clear on the severe weather front — not a single tornado, severe thunderstorm, or flash flood warning active across the country.',
            'A quiet pattern is in control nationwide ' + tod + '. No active severe weather warnings to report.'
        ]));
        var quietNote = _pick_random([
            '', '', '', '',
            ' Days like this are a good reminder to review your severe weather plan for when things do ramp up.',
            ' Enjoy the calm — it never lasts forever in the weather world.',
            ' A good time to charge up those weather radios and make sure your alert apps are configured.',
            ' Even on quiet days, it\'s worth keeping an eye on the forecast a few days out.'
        ]);
        if (quietNote) lines.push(quietNote);
    } else {
        var parts = [];
        if (torCount > 0) parts.push(torCount + ' tornado warning' + (torCount > 1 ? 's' : ''));
        if (svrCount > 0) parts.push(svrCount + ' severe thunderstorm warning' + (svrCount > 1 ? 's' : ''));
        if (ffwCount > 0) parts.push(ffwCount + ' flash flood warning' + (ffwCount > 1 ? 's' : ''));

        if (total >= 10) {
            lines.push(_pick_random([
                'It\'s an active pattern ' + tod + ' with ' + parts.join(', ') + ' across the country. Multiple areas are dealing with severe weather simultaneously.',
                'The warning map is lit up ' + tod + ': ' + parts.join(', ') + '. This is a busy weather day across the U.S.',
                'Plenty of action on the board — ' + parts.join(', ') + ' — a widespread severe weather event is underway.',
                'We\'re tracking a very active pattern with ' + parts.join(', ') + ' spanning multiple states. A lot happening at once.',
                'The severe weather machine is running full speed ' + tod + '. We\'ve got ' + parts.join(', ') + ' across the nation.'
            ]));
        } else if (total >= 4) {
            lines.push(_pick_random([
                'Several warnings are active right now: ' + parts.join(', ') + '. Multiple storm clusters are producing hazardous conditions.',
                'A moderate level of activity on the warning map with ' + parts.join(', ') + '. Several areas need to stay alert.',
                'We\'re tracking ' + parts.join(', ') + ' ' + tod + '. A handful of storm complexes are causing trouble.',
                'The warning count is climbing — ' + parts.join(', ') + ' across the country. Multiple areas are being impacted.',
                'Active weather across parts of the country with ' + parts.join(', ') + ' on the board.'
            ]));
        } else {
            lines.push(_pick_random([
                'Currently tracking ' + parts.join(' and ') + ' across the US.',
                'A few warnings are active ' + tod + ': ' + parts.join(' and ') + '.',
                'We\'ve got ' + parts.join(' and ') + ' on the map right now — let\'s keep an eye on those.',
                'Light activity on the warning map with ' + parts.join(' and ') + ' currently in effect.',
                'The warning count is low but not zero — tracking ' + parts.join(' and ') + ' ' + tod + '.'
            ]));
        }

        if (torCount >= 3) {
            lines.push(_pick_random([
                'With multiple tornado warnings active, this is a particularly dangerous weather situation unfolding in real time.',
                'The tornado threat is elevated across multiple locations. Stay tuned for rapid developments.',
                'Several tornado-warned storms are on the map — a sign of an active severe weather event in progress.',
                'Multiple tornado warnings simultaneously — that\'s a hallmark of a significant severe weather outbreak.',
                torCount + ' tornado warnings are active at once. This is the kind of situation where you stay glued to your weather sources.',
                'The tornado count is alarming — ' + torCount + ' active warnings tells us this is a serious and ongoing outbreak.'
            ]));
        } else if (torCount > 0) {
            lines.push(_pick_random([
                'At least one tornado warning is active. We\'ll focus in on that threat shortly.',
                'A tornado-warned storm is being tracked. Anyone in the warned area should be in shelter.',
                'With a tornado warning on the board, conditions are dangerous for parts of the country right now.',
                'There\'s a tornado warning active — we\'ll be zooming in on that shortly for a closer look.',
                'A confirmed tornado threat is on the map. If you\'re in the warned polygon, take shelter immediately.',
                'We\'ve got a tornado warning to keep our eye on. Stand by for a closer look at that storm.'
            ]));
        }
    }

    return lines.join(' ');
}

function _build_live_alert_html(feature) {
    var p = feature.properties || {};
    var event = p.event || 'Alert';
    var hexColor = '#ff4444';
    try { hexColor = chroma(get_polygon_colors(event).color).hex(); } catch (_) {}
    var params = p.parameters
        ? (typeof p.parameters === 'string' ? JSON.parse(p.parameters) : p.parameters)
        : {};
    var desc = (p.description || '').toUpperCase();
    var isTor = TORNADO_EVENTS.includes(event);
    var isConvective = ['Tornado Emergency', 'PDS Tornado Warning', 'Tornado Warning',
        'Severe Thunderstorm Warning', 'Severe Thunderstorm Watch', 'Tornado Watch'].indexOf(event) !== -1;

    var pills = [];

    if (isTor) {
        var torVal = _fn_arr(params.tornadoDetection);
        var torDisplay = torVal
            || (desc.includes('RADAR INDICATED') ? 'RADAR INDICATED' : null)
            || 'POSSIBLE';
        pills.push(torDisplay.toUpperCase());
    }

    var windVal = _fn_arr(params.maxWindGust);
    if (isConvective && windVal) pills.push(windVal);

    var hailVal = _fn_arr(params.maxHailSize);
    var hailNum = parseFloat(hailVal);
    if (isConvective && hailVal && !isNaN(hailNum) && hailNum > 0) {
        pills.push(hailNum.toFixed(2) + '" HAIL');
    }

    var damageThreat = _fn_arr(params.flashFloodDamageThreat) || _fn_arr(params.damageThreat);
    if (damageThreat) pills.push(damageThreat.toUpperCase());

    var areaDesc = p.areaDesc || '';

    var sourceStr = '';
    if (isTor) {
        sourceStr = _fn_arr(params.tornadoDetection)
            || (desc.includes('RADAR INDICATED') ? 'Radar.' : '')
            || 'Possible.';
    } else {
        sourceStr = _fn_arr(params.flashFloodDetection) || '';
        if (!sourceStr && (desc.includes('RADAR INDICATED') || desc.includes('RADAR-INDICATED'))) {
            sourceStr = 'Radar.';
        }
    }

    var html = '<div class="fnAlert" style="--fn-accent:' + hexColor + '">';
    html += '<div class="fnAlertShine"></div>';
    html += '<div class="fnAlertBody">';
    html += '<div class="fnAlertEventName">' + event + '</div>';

    if (pills.length) {
        html += '<div class="fnAlertPills">';
        for (var i = 0; i < pills.length; i++) {
            html += '<span class="fnAlertPill">' + pills[i] + '</span>';
        }
        html += '</div>';
    }

    html += '<div class="fnAlertDivider"></div>';
    html += '<div class="fnAlertRows">';

    if (areaDesc) {
        html += '<div class="fnAlertRow">';
        html += '<span class="fnAlertRowLabel">Areas</span>';
        html += '<span class="fnAlertRowValue">' + areaDesc + '</span>';
        html += '</div>';
    }

    if (sourceStr) {
        html += '<div class="fnAlertRow">';
        html += '<span class="fnAlertRowLabel">Source</span>';
        html += '<span class="fnAlertRowValue">' + sourceStr + '</span>';
        html += '</div>';
    }

    html += '</div>';
    html += '</div>';
    html += '</div>';
    return html;
}

function _build_spc_panel_html(label, validity) {
    var v = validity || {};
    var html = '<div class="fnAlert" style="--fn-accent:#0ea5e9">';
    html += '<div class="fnAlertShine"></div>';
    html += '<div class="fnAlertBody">';
    html += '<div class="fnAlertEventName">' + label + '</div>';

    if (v.validFrom || v.validUntil || v.lastUpdated) {
        html += '<div class="lmSpcMeta">';
        if (v.validFrom) {
            html += '<div class="lmSpcMetaRow"><span class="lmSpcMetaLabel">Valid from</span><span class="lmSpcMetaValue">' + v.validFrom + '</span></div>';
        }
        if (v.validUntil) {
            html += '<div class="lmSpcMetaRow"><span class="lmSpcMetaLabel">Valid until</span><span class="lmSpcMetaValue">' + v.validUntil + '</span></div>';
        }
        if (v.lastUpdated) {
            html += '<div class="lmSpcMetaRow"><span class="lmSpcMetaLabel">Updated</span><span class="lmSpcMetaValue">' + v.lastUpdated + '</span></div>';
        }
        html += '</div>';
    }

    html += '</div>';
    html += '</div>';
    return html;
}

function _build_conus_panel_html() {
    var html = '<div class="fnAlert" style="--fn-accent:#22c55e">';
    html += '<div class="fnAlertShine"></div>';
    html += '<div class="fnAlertBody">';
    html += '<div class="fnAlertEventName">CONUS MRMS RADAR</div>';
    html += '</div>';
    html += '</div>';
    return html;
}

function _reset_to_reflectivity() {
    var $refRow = $('.psmRow[value="ref"]').first();
    if ($refRow.length && !$refRow.hasClass('active')) {
        $refRow.trigger('click');
    }
}

function _trackAlertTimer(fn, ms) {
    var id = setTimeout(function () {
        var idx = _alertPendingTimers.indexOf(id);
        if (idx !== -1) _alertPendingTimers.splice(idx, 1);
        fn();
    }, ms);
    _alertPendingTimers.push(id);
    return id;
}

function _cancelAllAlertTimers() {
    for (var i = 0; i < _alertPendingTimers.length; i++) {
        clearTimeout(_alertPendingTimers[i]);
    }
    _alertPendingTimers = [];
}

function _run_alert_segment(resolve, forceFeature) {
    _currentSegmentType = 'alert';

    var epoch = ++_alertEpoch;
    _cancelAllAlertTimers();
    _cleanup_loop_listener();

    var controller = window.stormTrackData?.radarLoopController;
    if (controller) {
        try { controller.stop(); } catch (_) {}
        controller.state.frames = [];
        controller.state.currentFrameIndex = 0;
    }

    function isStale() { return epoch !== _alertEpoch || !_active; }

    var _resolved = false;
    function finish() {
        if (_resolved) return;
        _resolved = true;
        _cancelAllAlertTimers();
        _clear_segment_timer();
        _cleanup_loop_listener();
        _cleanup_scan_load_listener();
        _stop_typewriter();
        _remove_focus_glow();
        _remove_storm_track();
        _hide_info_panel();
        try {
            var ctrl = window.stormTrackData?.radarLoopController;
            if (ctrl) ctrl.stop();
        } catch (_) {}
        resolve();
    }

    var alerts = _get_active_severe_alerts();
    if (!alerts.length && !forceFeature) return resolve();

    var feature = forceFeature || null;
    if (!feature) {
        var unseen = alerts.filter(function (a) {
            return !_was_recent('alert', a.id || a?.properties?.id);
        });
        feature = unseen.length ? _pick_random(unseen) : _pick_random(alerts);
    }
    if (!feature) return resolve();

    _record_segment('alert', feature.id || feature?.properties?.id);

    _set_clock_mode('site-only');
    _ensure_single_site_mode();
    _reset_to_reflectivity();

    var station = _get_station_for_alert(feature);
    var isSameStation = false;
    if (station && nexrad_locations[station]) {
        isSameStation = window.stormTrackData.currentStation === station;
        if (controller) {
            controller.state.frameCount = PLAYBACK_FRAME_COUNT;
            controller.state.speedMultiplier = PLAYBACK_SPEED;
        }
        station_markers.selectStation(station, nexrad_locations[station].type || 'WSR-88D');
        if (isSameStation && controller && controller.state.active && controller.state.supported) {
            controller.refresh_frames();
        }
    }

    _fly_to_alert(feature);
    _add_focus_glow(feature);
    _show_info_panel(_build_live_alert_html(feature));

    var torEligible = _is_tornado_eligible(feature);
    var isTornado = TORNADO_EVENTS.includes(feature?.properties?.event || '');
    var motion = isTornado ? _extract_storm_motion(feature) : null;

    if (motion) _add_storm_track(motion, feature);

    if (isTornado && motion) {
        _find_major_city_in_polygon(feature, function (city) {
            if (isStale()) return;
            _typewrite(_generate_alert_commentary(feature, motion, city), 1200);
        });
    } else {
        _typewrite(_generate_alert_commentary(feature, null, null), 1200);
    }

    function _begin_playback() {
        if (isStale()) return finish();
        _run_playback(epoch, function () {
            if (isStale()) return finish();
            if (torEligible) {
                _switch_to_velocity(epoch, feature, function () {
                    if (isStale()) return finish();
                    _wait_for_typewriter_then(function () {
                        if (isStale()) return finish();
                        finish();
                    });
                });
            } else {
                _wait_for_typewriter_then(function () {
                    if (isStale()) return finish();
                    finish();
                });
            }
        });
    }

    _cleanup_scan_load_listener();

    if (isSameStation) {
        _trackAlertTimer(function () {
            _begin_playback();
        }, 500);
    } else {
        var _scanWaitDone = false;
        _scanLoadListener = function (e) {
            if (_scanWaitDone || isStale()) return;
            var detail = e?.detail || {};
            if (station && detail.station && detail.station !== station) return;
            _scanWaitDone = true;
            _cleanup_scan_load_listener();
            _trackAlertTimer(function () {
                _begin_playback();
            }, 300);
        };
        window.addEventListener('radarBaseFactoryLoaded', _scanLoadListener);
        _trackAlertTimer(function () {
            if (_scanWaitDone) return;
            _scanWaitDone = true;
            _cleanup_scan_load_listener();
            _begin_playback();
        }, 15000);
    }

    _segmentTimer = setTimeout(function () {
        if (isStale()) return;
        console.warn('[LiveMode] Alert segment safety timeout reached');
        finish();
    }, 90000);
}

// ── Radar Playback Sub-Segment ───────────────────────────────────────────────

function _run_playback(epoch, done) {
    var controller = window.stormTrackData?.radarLoopController;
    if (!controller) return done();

    function isStale() { return epoch !== _alertEpoch || !_active; }

    var _playbackDone = false;
    function finish() {
        if (_playbackDone) return;
        _playbackDone = true;
        _cleanup_loop_listener();
        try {
            if (controller) {
                controller.stop();
                var frames = controller.state.frames;
                if (frames && frames.length > 0) {
                    controller.plot_frame(frames.length - 1);
                }
            }
        } catch (_) {}
        done();
    }

    controller.state.speedMultiplier = PLAYBACK_SPEED;
    controller.state.frameCount = PLAYBACK_FRAME_COUNT;

    if (!controller.state.active || !controller.state.supported || !controller.current_station) {
        return done();
    }

    if (controller.state.playing || controller.state.preloading) {
        try { controller.stop(); } catch (_) {}
    }

    _loopCount = 0;
    _lastFrameIndex = -1;

    _loopListener = function (e) {
        if (isStale() || _playbackDone) { finish(); return; }
        var state = e?.detail || window.stormTrackData?.loopPlayback;
        if (!state || !state.playing) return;
        var idx = state.currentFrameIndex;
        var total = (state.frames && state.frames.length) || PLAYBACK_FRAME_COUNT;
        if (total > 1 && _lastFrameIndex === total - 1 && idx === 0) {
            _loopCount++;
        }
        _lastFrameIndex = idx;
        if (_loopCount >= PLAYBACK_LOOP_TARGET) {
            finish();
        }
    };
    window.addEventListener('radarLoopStateChanged', _loopListener);

    var _waitAttempts = 0;
    function _try_play() {
        if (isStale() || _playbackDone) return;
        var loopState = window.stormTrackData?.loopPlayback;
        if (!loopState || !loopState.active || !loopState.supported) {
            if (_waitAttempts < 60) { _waitAttempts++; _trackAlertTimer(_try_play, 400); }
            else finish();
            return;
        }
        if (loopState.preloading) {
            if (_waitAttempts < 60) { _waitAttempts++; _trackAlertTimer(_try_play, 400); }
            else finish();
            return;
        }
        if (!loopState.frames || loopState.frames.length === 0) {
            if (_waitAttempts < 60) { _waitAttempts++; _trackAlertTimer(_try_play, 400); }
            else finish();
            return;
        }
        controller.state.speedMultiplier = PLAYBACK_SPEED;
        if (loopState.playing) {
            try { controller.pause(); } catch (_) {}
        }
        try { controller.play(); } catch (_) { finish(); return; }
    }
    _trackAlertTimer(_try_play, 500);

    _trackAlertTimer(function () {
        if (isStale()) return;
        finish();
    }, 60000);
}

function _cleanup_loop_listener() {
    if (_loopListener) {
        window.removeEventListener('radarLoopStateChanged', _loopListener);
        _loopListener = null;
    }
}

function _cleanup_scan_load_listener() {
    if (_scanLoadListener) {
        window.removeEventListener('radarBaseFactoryLoaded', _scanLoadListener);
        _scanLoadListener = null;
    }
}

function _switch_to_velocity(epoch, feature, done) {
    function isStale() { return epoch !== _alertEpoch || !_active; }

    var $velRow = $('.psmRow[value="vel"]').first();
    if ($velRow.length) {
        $velRow.trigger('click');
    }

    if (feature && feature.geometry) {
        try {
            var centroid = turf.centroid(turf.feature(feature.geometry));
            var coords = centroid.geometry.coordinates;
            map.flyTo({
                center: coords,
                zoom: Math.max((map.getZoom() || 7) + 1.5, 9),
                speed: 0.8,
                curve: 1.2,
                essential: true
            });
        } catch (_) {}
    }

    _trackAlertTimer(function () {
        if (isStale()) return done();
        var $refRow = $('.psmRow[value="ref"]').first();
        if ($refRow.length) $refRow.trigger('click');
        _trackAlertTimer(function () {
            done();
        }, 300);
    }, VELOCITY_HOLD_MS);
}

// ── Radar Spotlight Segment ──────────────────────────────────────────────────

function _get_all_alert_stations() {
    var data = window.stormTrackData?.alerts_data;
    if (!data || !data.features) return [];
    var stationCounts = {};
    for (var i = 0; i < data.features.length; i++) {
        var f = data.features[i];
        if (!f.geometry) continue;
        var ev = f?.properties?.event || '';
        if (ev.includes('Watch') || ev.includes('Advisory') || ev.includes('Statement')) continue;
        try {
            var s = alert_helpers.get_best_wsr88d_radar(f.geometry);
            if (s && nexrad_locations[s]) {
                stationCounts[s] = (stationCounts[s] || 0) + 1;
            }
        } catch (_) {}
    }
    return Object.entries(stationCounts)
        .sort(function (a, b) { return b[1] - a[1]; })
        .map(function (e) { return e[0]; });
}

var _PROBE_STATIONS = [
    'KFWS', 'KLIX', 'KTLX', 'KBMX', 'KAMA', 'KDDC', 'KICT', 'KSGF',
    'KLZK', 'KJAX', 'KMHX', 'KLWX', 'KCLE', 'KGRR', 'KMPX', 'KDTX',
    'KLOT', 'KPAH', 'KHGX', 'KEWX', 'KDFX', 'KFDR', 'KINX', 'KEAX',
    'KLSX', 'KMRX', 'KOHX', 'KHTX', 'KMOB', 'KEVX', 'KTLH', 'KMLB',
    'KATX', 'KRTX', 'KMTX', 'KFCX', 'KPBZ', 'KOKX', 'KBOX', 'KGYX'
];

function _is_conus_station(station) {
    var loc = nexrad_locations[station];
    if (!loc) return false;
    var lat = loc.lat || loc.latitude;
    var lng = loc.lon || loc.lng || loc.longitude;
    return lat >= 24 && lat <= 50 && lng >= -125 && lng <= -66;
}

function _has_precipitation(factory) {
    try {
        var symBlock = factory.initial_radar_obj.sym_block;
        if (!symBlock || !symBlock[0] || !symBlock[0][0] || !symBlock[0][0].data) return false;
        var data = symBlock[0][0].data;
        var hitCount = 0;
        var threshold = 2;
        for (var r = 0; r < data.length; r += 4) {
            var radial = data[r];
            if (!radial) continue;
            for (var g = 0; g < radial.length; g += 3) {
                if (radial[g] > threshold) {
                    hitCount++;
                    if (hitCount >= 20) return true;
                }
            }
        }
        return false;
    } catch (_) {
        return false;
    }
}

function _pick_spotlight_station(callback) {
    var loaders = require('../radar/libnexrad/loaders_nexrad');

    var alertStations = _get_all_alert_stations().filter(_is_conus_station);
    var severeStations = _get_active_severe_alerts().map(function (f) {
        try { return alert_helpers.get_best_wsr88d_radar(f.geometry); } catch (_) { return null; }
    }).filter(Boolean);

    var alertCandidates = alertStations.filter(function (s) { return severeStations.indexOf(s) === -1; });
    var unseenAlert = alertCandidates.filter(function (s) { return !_was_recent('spotlight', s); });
    var orderedAlertCandidates = unseenAlert.length ? unseenAlert : alertCandidates;

    var probeList = _PROBE_STATIONS.filter(function (s) {
        return !_was_recent('spotlight', s) && nexrad_locations[s];
    });
    if (!probeList.length) probeList = _PROBE_STATIONS.slice();
    var probeShuffled = probeList.sort(function () { return Math.random() - 0.5; }).slice(0, 8);

    var allToCheck = orderedAlertCandidates.slice(0, 4).concat(probeShuffled);
    var seen = {};
    var unique = [];
    for (var u = 0; u < allToCheck.length; u++) {
        if (!seen[allToCheck[u]]) { seen[allToCheck[u]] = true; unique.push(allToCheck[u]); }
    }

    var checked = 0;
    var precipStations = [];
    var best = null;
    var bestDate = 0;

    for (var i = 0; i < unique.length; i++) {
        (function (station) {
            loaders.get_latest_level_3_url(station, 'p94r0', 0, function (url, date) {
                if (!url) {
                    checked++;
                    if (checked >= unique.length) _finalize();
                    return;
                }
                if (date) {
                    var ts = date.getTime();
                    if (ts > bestDate) { bestDate = ts; best = station; }
                }
                loaders.return_level_3_factory_from_url(url, function (factory) {
                    checked++;
                    if (factory && _has_precipitation(factory)) {
                        precipStations.push(station);
                    }
                    if (checked >= unique.length) _finalize();
                });
            });
        })(unique[i]);
    }

    function _finalize() {
        if (precipStations.length) {
            callback(_pick_random(precipStations));
        } else {
            callback(best || _pick_random(unique));
        }
    }
}

function _generate_spotlight_commentary(station) {
    var loc = nexrad_locations[station] || {};
    var name = loc.name || station;
    var tod = _time_of_day();
    var lines = [];

    var stationTrivia = '';
    var stationUpper = station.toUpperCase();
    if (stationUpper === 'KTLX') stationTrivia = _pick_random(['This is the famous Twin Lakes radar just south of Oklahoma City — ground zero for storm chasing. ', 'KTLX has scanned more tornadoes than almost any radar in the network. ', '']);
    else if (stationUpper === 'KFWS') stationTrivia = _pick_random(['The Fort Worth radar sits in the heart of North Texas\'s severe weather alley. ', 'KFWS covers the sprawling Dallas-Fort Worth metroplex — one of the largest urban areas in the country. ', '']);
    else if (stationUpper === 'KLIX') stationTrivia = _pick_random(['The Slidell radar covers the Gulf Coast from southern Louisiana to the Mississippi coast. ', 'KLIX keeps watch over New Orleans and the surrounding bayou country. ', '']);
    else if (stationUpper === 'KBMX') stationTrivia = _pick_random(['The Birmingham radar covers one of the most tornado-prone regions in the Southeast. ', 'Central Alabama is Dixie Alley territory — this radar has seen its share of severe weather. ', '']);
    else if (stationUpper === 'KLOT') stationTrivia = _pick_random(['The Chicago radar covers the greater Chicagoland area and northwest Indiana. ', 'KLOT keeps tabs on weather across the southern Lake Michigan shore. ', '']);
    else if (stationUpper === 'KHGX') stationTrivia = _pick_random(['The Houston radar monitors one of the most flood-prone metro areas in the nation. ', 'KHGX covers the Gulf Coast from Houston to Galveston Bay. ', '']);
    else if (stationUpper === 'KATX') stationTrivia = _pick_random(['The Seattle radar watches over the Puget Sound and the Cascade foothills. ', 'KATX covers the Pacific Northwest — one of the rainiest corners of the lower 48. ', '']);
    else if (stationUpper === 'KMPX') stationTrivia = _pick_random(['The Twin Cities radar covers the Minneapolis-St. Paul metro and surrounding plains. ', 'KMPX sits in the northern plains where severe weather season runs from May through August. ', '']);

    var severeAlerts = _get_active_severe_alerts();
    var nearbyWarnings = [];
    for (var i = 0; i < severeAlerts.length; i++) {
        var f = severeAlerts[i];
        if (!f.geometry) continue;
        try {
            var s = alert_helpers.get_best_wsr88d_radar(f.geometry);
            if (s === station) nearbyWarnings.push(f);
        } catch (_) {}
    }

    var warningCount = nearbyWarnings.length;
    if (warningCount > 1) {
        lines.push(_pick_random([
            'Focusing on the ' + name + ' radar ' + tod + ', where multiple severe warnings are active across the coverage area.',
            'The ' + name + ' radar is lighting up ' + tod + ' with ' + warningCount + ' active severe warnings in its range.',
            'Let\'s check in on ' + name + ' — this radar has been busy ' + tod + ' with several severe warnings in the area.',
            'The ' + name + ' radar has its hands full ' + tod + ' — ' + warningCount + ' severe warnings are in play across its coverage domain.',
            'Spotlight on ' + name + ' ' + tod + ', where the radar is tracking multiple warned storms. ' + warningCount + ' severe warnings active.',
            'We\'re zeroing in on the ' + name + ' radar, which is tracking ' + warningCount + ' active severe warnings in its scan area right now.',
            name + ' is one of the busier radars on the map ' + tod + ' with ' + warningCount + ' active severe warnings to keep track of.'
        ]));
    } else if (warningCount === 1) {
        var warnType = nearbyWarnings[0]?.properties?.event || 'a severe warning';
        lines.push(_pick_random([
            'Turning to the ' + name + ' radar, where ' + warnType.toLowerCase().replace('warning', '').trim() + ' conditions are being tracked.',
            'The ' + name + ' radar is monitoring active weather ' + tod + ', with a ' + warnType.toLowerCase() + ' in effect nearby.',
            'Let\'s look at what the ' + name + ' radar is picking up — there\'s an active ' + warnType.toLowerCase() + ' in this area.',
            'Spotlight time on ' + name + ', where a ' + warnType.toLowerCase() + ' is active within its scan range.',
            'The ' + name + ' radar has an active ' + warnType.toLowerCase() + ' in its coverage area ' + tod + '. Let\'s see what\'s going on.',
            name + ' is tracking a ' + warnType.toLowerCase().replace('warning', '').trim() + ' threat right now. Let\'s take a closer look at the returns.',
            'Swinging over to the ' + name + ' Doppler, which has a ' + warnType.toLowerCase() + ' in the vicinity ' + tod + '.'
        ]));
    } else {
        lines.push(_pick_random([
            'Checking in on the ' + name + ' radar ' + tod + '. This site is showing some active precipitation on the scope.',
            'Let\'s take a look at the ' + name + ' radar, which is picking up returns across its coverage area ' + tod + '.',
            'Turning to the ' + name + ' Doppler radar for a closer look at precipitation moving through the region.',
            'The ' + name + ' radar is showing some activity ' + tod + '. Let\'s break down what we\'re seeing.',
            'Spotlight on ' + name + ' ' + tod + '. The radar is painting some precipitation — let\'s take a closer look.',
            'Let\'s swing by ' + name + ' and see what the Doppler has for us ' + tod + '. Looks like there\'s some precipitation on the scope.',
            'Time to check in with the ' + name + ' radar. Some returns are showing up across the coverage area ' + tod + '.'
        ]));
    }

    if (stationTrivia) lines.push(stationTrivia);

    lines.push(_pick_random([
        'We\'ll watch the reflectivity loop to see how this precipitation has been evolving over the last several scans.',
        'Let\'s roll through the radar loop and see how this weather has been trending.',
        'Looking at the last several radar scans, we can track the movement and intensity of this precipitation.',
        'The radar loop will show us how this system has been moving and whether it\'s strengthening or weakening.',
        'Let\'s run the loop and see how this precipitation has been behaving — is it building, holding steady, or fading?',
        'We\'ll cycle through the recent scans to get a sense of the storm motion and evolution.',
        'The reflectivity loop is the best way to see the trend — let\'s watch how this weather has been progressing.'
    ]));

    return lines.join(' ');
}

function _build_spotlight_panel_html(station) {
    var loc = nexrad_locations[station] || {};
    var name = loc.name || station;
    var html = '<div class="fnAlert" style="--fn-accent:#38bdf8">';
    html += '<div class="fnAlertShine"></div>';
    html += '<div class="fnAlertBody">';
    html += '<div class="fnAlertEventName">RADAR SPOTLIGHT</div>';
    html += '<div class="fnAlertSourceLine" style="margin-top:4px;opacity:0.75">' + station + ' — ' + name + '</div>';
    html += '</div>';
    html += '</div>';
    return html;
}

function _run_spotlight_segment(resolve) {
    _currentSegmentType = 'spotlight';

    var epoch = ++_alertEpoch;
    _cancelAllAlertTimers();
    _cleanup_loop_listener();

    var controller = window.stormTrackData?.radarLoopController;
    if (controller) {
        try { controller.stop(); } catch (_) {}
        controller.state.frames = [];
        controller.state.currentFrameIndex = 0;
    }

    function isStale() { return epoch !== _alertEpoch || !_active; }

    var _resolved = false;
    function finish() {
        if (_resolved) return;
        _resolved = true;
        _cancelAllAlertTimers();
        _clear_segment_timer();
        _cleanup_loop_listener();
        _stop_typewriter();
        _hide_info_panel();
        try {
            var ctrl = window.stormTrackData?.radarLoopController;
            if (ctrl) ctrl.stop();
        } catch (_) {}
        resolve();
    }

    _set_clock_mode('site-only');

    _pick_spotlight_station(function (station) {
        if (isStale()) return finish();
        if (!station || !nexrad_locations[station]) return finish();

        _record_segment('spotlight', station);

        _ensure_single_site_mode();
        _reset_to_reflectivity();

        controller = window.stormTrackData?.radarLoopController;
        var isSameStation = window.stormTrackData.currentStation === station;
        if (controller) {
            controller.state.frameCount = PLAYBACK_FRAME_COUNT;
            controller.state.speedMultiplier = PLAYBACK_SPEED;
        }
        station_markers.selectStation(station, nexrad_locations[station].type || 'WSR-88D');
        if (isSameStation && controller && controller.state.active && controller.state.supported) {
            controller.refresh_frames();
        }

        var loc = nexrad_locations[station];
        map.flyTo({
            center: [loc.lon, loc.lat],
            zoom: 7,
            speed: 1.2,
            essential: true
        });

        _show_info_panel(_build_spotlight_panel_html(station));
        _typewrite(_generate_spotlight_commentary(station), 1200);

        _trackAlertTimer(function () {
            if (isStale()) return finish();
            _run_playback(epoch, function () {
                if (isStale()) return finish();
                _wait_for_typewriter_then(function () {
                    if (isStale()) return finish();
                    finish();
                });
            });
        }, 1000);

        _segmentTimer = setTimeout(function () {
            if (isStale()) return;
            console.warn('[LiveMode] Spotlight segment safety timeout reached');
            finish();
        }, 90000);
    });
}

// ── CONUS Radar Segment ──────────────────────────────────────────────────────

const CONUS_MRMS_SOURCE = 'liveModeMrmsSource';
const CONUS_MRMS_LAYER = 'liveModeMrmsLayer';
const MRMS_WMS_URL = 'https://nowcoast.noaa.gov/geoserver/weather_radar/wms?service=WMS&version=1.3.0&request=GetMap&layers=weather_radar:conus_base_reflectivity_mosaic&styles=&format=image/png&transparent=true&width=256&height=256&crs=EPSG:3857&bbox={bbox-epsg-3857}';

function _add_static_mrms_layer() {
    _remove_static_mrms_layer();

    var opacity = 0.85;
    if (window.stormTrackData?.radarOpacity != null) opacity = window.stormTrackData.radarOpacity;

    map.addSource(CONUS_MRMS_SOURCE, {
        type: 'raster',
        tiles: [MRMS_WMS_URL],
        tileSize: 256,
        attribution: 'NOAA nowCOAST'
    });

    var beforeLayer = undefined;
    try {
        var mapFuncs = require('../core/map/mapFunctions');
        beforeLayer = mapFuncs.get_base_layer();
    } catch (_) {}

    map.addLayer({
        id: CONUS_MRMS_LAYER,
        type: 'raster',
        source: CONUS_MRMS_SOURCE,
        paint: {
            'raster-opacity': opacity,
            'raster-fade-duration': 0
        }
    }, beforeLayer);
}

function _remove_static_mrms_layer() {
    if (map.getLayer(CONUS_MRMS_LAYER)) map.removeLayer(CONUS_MRMS_LAYER);
    if (map.getSource(CONUS_MRMS_SOURCE)) map.removeSource(CONUS_MRMS_SOURCE);
}

function _ensure_single_site_mode() {
    if (window.stormTrackData.usRadarEnabled) {
        var settings = require('../core/menu/settings');
        if (settings.applyUSRadarMode) settings.applyUSRadarMode(false);
    }
}

function _run_conus_segment(resolve) {
    _currentSegmentType = 'conus';
    _record_segment('conus', 'conus');
    _set_clock_mode('hidden');
    _hide_header_radar_info(null);
    _show_info_panel(_build_conus_panel_html());

    _ensure_single_site_mode();
    _hide_radar_render();
    _hide_station_markers();
    _hide_alert_polygons();
    _hide_radar_sweep();
    _add_static_mrms_layer();
    map.flyTo({ center: CONUS_CENTER, zoom: CONUS_ZOOM, speed: 1.2, essential: true });
    if (Math.random() > 0.35) {
        _typewrite(_generate_conus_commentary(), 1200);
    }

    _segmentTimer = setTimeout(function () {
        _wait_for_typewriter_then(function () {
            _stop_typewriter();
            _hide_info_panel();
            _remove_static_mrms_layer();
            _show_radar_render();
            _show_station_markers();
            _show_alert_polygons();
            _show_radar_sweep();
            _show_header_radar_info();
            resolve();
        });
    }, CONUS_SEGMENT_DURATION_MS);
}

// ── Current Conditions Segment ───────────────────────────────────────────────

const CONDITIONS_DURATION_MS = 20000;
const LM_CONDITIONS_SOURCE = 'lmConditionsSource';
const LM_CONDITIONS_CIRCLE = 'lmConditionsCircle';
const LM_CONDITIONS_LABEL = 'lmConditionsLabel';

var CONDITION_REGIONS = [
    {
        name: 'Northeast', center: [-74.5, 41.5], zoom: 5.6,
        cities: [
            { name: 'New York', station: 'KJFK', lat: 40.64, lng: -73.78 },
            { name: 'Boston', station: 'KBOS', lat: 42.36, lng: -71.01 },
            { name: 'Philadelphia', station: 'KPHL', lat: 39.87, lng: -75.24 },
            { name: 'Pittsburgh', station: 'KPIT', lat: 40.49, lng: -80.23 },
            { name: 'Burlington', station: 'KBTV', lat: 44.47, lng: -73.15 },
            { name: 'Portland ME', station: 'KPWM', lat: 43.65, lng: -70.31 },
            { name: 'Washington DC', station: 'KDCA', lat: 38.85, lng: -77.03 },
            { name: 'Hartford', station: 'KBDL', lat: 41.94, lng: -72.68 },
            { name: 'Albany', station: 'KALB', lat: 42.75, lng: -73.80 },
            { name: 'Buffalo', station: 'KBUF', lat: 42.94, lng: -78.74 },
            { name: 'Baltimore', station: 'KBWI', lat: 39.18, lng: -76.67 },
            { name: 'Syracuse', station: 'KSYR', lat: 43.11, lng: -76.11 },
            { name: 'Providence', station: 'KPVD', lat: 41.72, lng: -71.43 },
            { name: 'Richmond', station: 'KRIC', lat: 37.51, lng: -77.32 }
        ]
    },
    {
        name: 'Southeast', center: [-83.5, 31.5], zoom: 5.3,
        cities: [
            { name: 'Atlanta', station: 'KATL', lat: 33.64, lng: -84.43 },
            { name: 'Miami', station: 'KMIA', lat: 25.79, lng: -80.29 },
            { name: 'Tampa', station: 'KTPA', lat: 27.98, lng: -82.53 },
            { name: 'Charlotte', station: 'KCLT', lat: 35.22, lng: -80.94 },
            { name: 'Jacksonville', station: 'KJAX', lat: 30.49, lng: -81.69 },
            { name: 'Raleigh', station: 'KRDU', lat: 35.88, lng: -78.79 },
            { name: 'Nashville', station: 'KBNA', lat: 36.12, lng: -86.68 },
            { name: 'Birmingham', station: 'KBHM', lat: 33.56, lng: -86.75 },
            { name: 'New Orleans', station: 'KMSY', lat: 29.99, lng: -90.26 },
            { name: 'Savannah', station: 'KSAV', lat: 32.13, lng: -81.20 },
            { name: 'Orlando', station: 'KMCO', lat: 28.43, lng: -81.31 },
            { name: 'Charleston', station: 'KCHS', lat: 32.90, lng: -80.04 },
            { name: 'Knoxville', station: 'KTYS', lat: 35.81, lng: -83.99 },
            { name: 'Mobile', station: 'KMOB', lat: 30.69, lng: -88.25 }
        ]
    },
    {
        name: 'Midwest', center: [-87.0, 41.0], zoom: 5.3,
        cities: [
            { name: 'Chicago', station: 'KORD', lat: 41.98, lng: -87.90 },
            { name: 'Detroit', station: 'KDTW', lat: 42.21, lng: -83.35 },
            { name: 'Minneapolis', station: 'KMSP', lat: 44.88, lng: -93.22 },
            { name: 'St. Louis', station: 'KSTL', lat: 38.75, lng: -90.37 },
            { name: 'Indianapolis', station: 'KIND', lat: 39.72, lng: -86.29 },
            { name: 'Cleveland', station: 'KCLE', lat: 41.41, lng: -81.85 },
            { name: 'Cincinnati', station: 'KCVG', lat: 39.05, lng: -84.67 },
            { name: 'Milwaukee', station: 'KMKE', lat: 42.95, lng: -87.90 },
            { name: 'Columbus', station: 'KCMH', lat: 39.99, lng: -82.89 },
            { name: 'Des Moines', station: 'KDSM', lat: 41.53, lng: -93.66 },
            { name: 'Louisville', station: 'KSDF', lat: 38.17, lng: -85.74 },
            { name: 'Grand Rapids', station: 'KGRR', lat: 42.88, lng: -85.52 },
            { name: 'Green Bay', station: 'KGRB', lat: 44.49, lng: -88.13 },
            { name: 'Springfield', station: 'KSPI', lat: 39.84, lng: -89.68 }
        ]
    },
    {
        name: 'Southern Plains', center: [-96.0, 33.0], zoom: 5.3,
        cities: [
            { name: 'Dallas', station: 'KDFW', lat: 32.90, lng: -97.04 },
            { name: 'Houston', station: 'KIAH', lat: 29.98, lng: -95.34 },
            { name: 'San Antonio', station: 'KSAT', lat: 29.53, lng: -98.47 },
            { name: 'Oklahoma City', station: 'KOKC', lat: 35.39, lng: -97.60 },
            { name: 'Little Rock', station: 'KLIT', lat: 34.73, lng: -92.22 },
            { name: 'Memphis', station: 'KMEM', lat: 35.04, lng: -89.98 },
            { name: 'Tulsa', station: 'KTUL', lat: 36.20, lng: -95.89 },
            { name: 'Austin', station: 'KAUS', lat: 30.19, lng: -97.67 },
            { name: 'Shreveport', station: 'KSHV', lat: 32.45, lng: -93.83 },
            { name: 'Wichita', station: 'KICT', lat: 37.65, lng: -97.43 },
            { name: 'Lubbock', station: 'KLBB', lat: 33.67, lng: -101.82 },
            { name: 'Corpus Christi', station: 'KCRP', lat: 27.77, lng: -97.51 },
            { name: 'Jackson MS', station: 'KJAN', lat: 32.31, lng: -90.08 },
            { name: 'Amarillo', station: 'KAMA', lat: 35.22, lng: -101.71 }
        ]
    },
    {
        name: 'Northern Plains', center: [-98.0, 43.5], zoom: 5.3,
        cities: [
            { name: 'Kansas City', station: 'KMCI', lat: 39.30, lng: -94.71 },
            { name: 'Omaha', station: 'KOMA', lat: 41.30, lng: -95.89 },
            { name: 'Fargo', station: 'KFAR', lat: 46.92, lng: -96.82 },
            { name: 'Bismarck', station: 'KBIS', lat: 46.77, lng: -100.75 },
            { name: 'Sioux Falls', station: 'KFSD', lat: 43.58, lng: -96.74 },
            { name: 'Rapid City', station: 'KRAP', lat: 44.05, lng: -103.05 },
            { name: 'Lincoln', station: 'KLNK', lat: 40.85, lng: -96.76 },
            { name: 'Grand Forks', station: 'KGFK', lat: 47.95, lng: -97.18 },
            { name: 'Topeka', station: 'KTOP', lat: 39.07, lng: -95.62 },
            { name: 'Duluth', station: 'KDLH', lat: 46.84, lng: -92.19 },
            { name: 'Casper', station: 'KCPR', lat: 42.91, lng: -106.46 },
            { name: 'Aberdeen', station: 'KABR', lat: 45.45, lng: -98.42 }
        ]
    },
    {
        name: 'Mountain West', center: [-110.0, 38.5], zoom: 5.1,
        cities: [
            { name: 'Denver', station: 'KDEN', lat: 39.86, lng: -104.67 },
            { name: 'Phoenix', station: 'KPHX', lat: 33.43, lng: -112.00 },
            { name: 'Salt Lake City', station: 'KSLC', lat: 40.79, lng: -111.98 },
            { name: 'Albuquerque', station: 'KABQ', lat: 35.04, lng: -106.62 },
            { name: 'Las Vegas', station: 'KLAS', lat: 36.08, lng: -115.15 },
            { name: 'Boise', station: 'KBOI', lat: 43.56, lng: -116.22 },
            { name: 'Billings', station: 'KBIL', lat: 45.81, lng: -108.54 },
            { name: 'Tucson', station: 'KTUS', lat: 32.12, lng: -110.94 },
            { name: 'El Paso', station: 'KELP', lat: 31.81, lng: -106.38 },
            { name: 'Colorado Springs', station: 'KCOS', lat: 38.81, lng: -104.70 },
            { name: 'Reno', station: 'KRNO', lat: 39.50, lng: -119.77 },
            { name: 'Missoula', station: 'KMSO', lat: 46.92, lng: -114.09 },
            { name: 'Flagstaff', station: 'KFLG', lat: 35.14, lng: -111.67 },
            { name: 'Grand Junction', station: 'KGJT', lat: 39.12, lng: -108.53 }
        ]
    },
    {
        name: 'Pacific Coast', center: [-120.5, 40.0], zoom: 5.1,
        cities: [
            { name: 'Los Angeles', station: 'KLAX', lat: 33.94, lng: -118.41 },
            { name: 'San Francisco', station: 'KSFO', lat: 37.62, lng: -122.38 },
            { name: 'Seattle', station: 'KSEA', lat: 47.45, lng: -122.31 },
            { name: 'Portland', station: 'KPDX', lat: 45.59, lng: -122.60 },
            { name: 'San Diego', station: 'KSAN', lat: 32.73, lng: -117.19 },
            { name: 'Sacramento', station: 'KSMF', lat: 38.70, lng: -121.59 },
            { name: 'Medford', station: 'KMFR', lat: 42.37, lng: -122.87 },
            { name: 'Fresno', station: 'KFAT', lat: 36.78, lng: -119.72 },
            { name: 'San Jose', station: 'KSJC', lat: 37.36, lng: -121.93 },
            { name: 'Spokane', station: 'KGEG', lat: 47.62, lng: -117.53 },
            { name: 'Eureka', station: 'KACV', lat: 40.98, lng: -124.11 },
            { name: 'Palm Springs', station: 'KPSP', lat: 33.83, lng: -116.51 }
        ]
    }
];

function _get_all_region_stations() {
    var stations = [];
    for (var r = 0; r < CONDITION_REGIONS.length; r++) {
        for (var c = 0; c < CONDITION_REGIONS[r].cities.length; c++) {
            stations.push(CONDITION_REGIONS[r].cities[c].station);
        }
    }
    return stations;
}

function _compute_feels_like(tempF, dewF, wspd) {
    if (tempF == null) return null;
    if (tempF >= 80 && dewF != null) {
        var T = tempF, R = Math.min(100, Math.max(0, 100 * Math.pow((112 - (0.1 * T) + dewF) / (112 + (0.9 * T)), 8)));
        var HI = -42.379 + 2.04901523 * T + 10.14333127 * R
            - 0.22475541 * T * R - 0.00683783 * T * T
            - 0.05481717 * R * R + 0.00122874 * T * T * R
            + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R;
        return Math.round(HI);
    }
    if (tempF <= 50 && wspd != null && wspd > 3) {
        var mph = wspd * 1.15078;
        var WC = 35.74 + 0.6215 * tempF - 35.75 * Math.pow(mph, 0.16) + 0.4275 * tempF * Math.pow(mph, 0.16);
        return Math.round(WC);
    }
    return Math.round(tempF);
}

function _fetch_observations(callback) {
    var allStations = _get_all_region_stations();
    var unique = allStations.filter(function (s, i) { return allStations.indexOf(s) === i; });
    var url = '/api/metar?ids=' + unique.join(',');
    fetch(url, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
            if (!Array.isArray(data)) return callback({});
            var result = {};
            for (var i = 0; i < data.length; i++) {
                var ob = data[i];
                if (!ob || !ob.icaoId) continue;
                var tempC = ob.temp != null ? ob.temp : null;
                var dewC = ob.dewp != null ? ob.dewp : null;
                result[ob.icaoId] = {
                    tempF: tempC != null ? Math.round(tempC * 9 / 5 + 32) : null,
                    dewF: dewC != null ? Math.round(dewC * 9 / 5 + 32) : null,
                    tempC: tempC != null ? Math.round(tempC) : null,
                    dewC: dewC != null ? Math.round(dewC) : null,
                    wdir: ob.wdir || null,
                    wspd: ob.wspd != null ? ob.wspd : null,
                    wxString: ob.wxString || '',
                    visib: ob.visib != null ? ob.visib : null
                };
            }
            callback(result);
        })
        .catch(function () { callback({}); });
}

var LM_CONDITIONS_CITY_LABEL = 'lmConditionsCityLabel';
var LM_CONDITIONS_FEELS_LABEL = 'lmConditionsFeelsLabel';

function _add_conditions_layer(region, observations) {
    _remove_conditions_layer();
    var getTempColor = require('../core/misc/temp_colors');

    var cities = region.cities;
    var features = [];
    for (var i = 0; i < cities.length; i++) {
        var city = cities[i];
        var ob = observations[city.station];
        if (!ob || ob.tempF == null) continue;
        var feelsLike = _compute_feels_like(ob.tempF, ob.dewF, ob.wspd);
        var colors = getTempColor(ob.tempF);
        var bgColor = typeof colors[0] === 'string' ? colors[0] : colors[0].css();
        var tempLabel = ob.tempF + '°';
        var feelsLabel = (feelsLike != null && feelsLike !== ob.tempF) ? ('Feels ' + feelsLike + '°') : '';
        features.push(turf.point([city.lng, city.lat], {
            name: city.name,
            tempLabel: tempLabel,
            feelsLabel: feelsLabel,
            tempF: ob.tempF,
            feelsLike: feelsLike,
            color: bgColor,
            textColor: colors[1]
        }));
    }

    map.addSource(LM_CONDITIONS_SOURCE, {
        type: 'geojson',
        data: turf.featureCollection(features)
    });

    map.addLayer({
        id: LM_CONDITIONS_CIRCLE,
        type: 'circle',
        source: LM_CONDITIONS_SOURCE,
        paint: {
            'circle-radius': [
                'interpolate', ['linear'], ['zoom'],
                4, 18,
                5.5, 24,
                7, 32
            ],
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.88,
            'circle-stroke-width': 2,
            'circle-stroke-color': 'rgba(255,255,255,0.5)'
        }
    });

    // Temperature number inside the circle
    map.addLayer({
        id: LM_CONDITIONS_LABEL,
        type: 'symbol',
        source: LM_CONDITIONS_SOURCE,
        layout: {
            'text-field': ['get', 'tempLabel'],
            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
            'text-size': [
                'interpolate', ['linear'], ['zoom'],
                4, 14,
                5.5, 18,
                7, 22
            ],
            'text-anchor': 'center',
            'text-allow-overlap': true
        },
        paint: {
            'text-color': '#ffffff',
            'text-halo-color': 'rgba(0,0,0,0.6)',
            'text-halo-width': 1.5
        }
    });

    // City name above the circle
    map.addLayer({
        id: LM_CONDITIONS_CITY_LABEL,
        type: 'symbol',
        source: LM_CONDITIONS_SOURCE,
        layout: {
            'text-field': ['get', 'name'],
            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
            'text-size': [
                'interpolate', ['linear'], ['zoom'],
                4, 9,
                5.5, 11,
                7, 13
            ],
            'text-anchor': 'bottom',
            'text-offset': [0, -2.2],
            'text-allow-overlap': true
        },
        paint: {
            'text-color': 'rgba(255, 255, 255, 0.9)',
            'text-halo-color': 'rgba(0,0,0,0.9)',
            'text-halo-width': 1.5
        }
    });

    // "Feels like" below the circle
    map.addLayer({
        id: LM_CONDITIONS_FEELS_LABEL,
        type: 'symbol',
        source: LM_CONDITIONS_SOURCE,
        layout: {
            'text-field': ['get', 'feelsLabel'],
            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
            'text-size': [
                'interpolate', ['linear'], ['zoom'],
                4, 8,
                5.5, 10,
                7, 11
            ],
            'text-anchor': 'top',
            'text-offset': [0, 2.0],
            'text-allow-overlap': true
        },
        paint: {
            'text-color': 'rgba(255, 255, 255, 0.6)',
            'text-halo-color': 'rgba(0,0,0,0.8)',
            'text-halo-width': 1.2
        }
    });
}

function _remove_conditions_layer() {
    try { if (map.getLayer(LM_CONDITIONS_FEELS_LABEL)) map.removeLayer(LM_CONDITIONS_FEELS_LABEL); } catch (_) {}
    try { if (map.getLayer(LM_CONDITIONS_CITY_LABEL)) map.removeLayer(LM_CONDITIONS_CITY_LABEL); } catch (_) {}
    try { if (map.getLayer(LM_CONDITIONS_LABEL)) map.removeLayer(LM_CONDITIONS_LABEL); } catch (_) {}
    try { if (map.getLayer(LM_CONDITIONS_CIRCLE)) map.removeLayer(LM_CONDITIONS_CIRCLE); } catch (_) {}
    try { if (map.getSource(LM_CONDITIONS_SOURCE)) map.removeSource(LM_CONDITIONS_SOURCE); } catch (_) {}
}

function _generate_conditions_commentary(region, observations) {
    var tod = _time_of_day();
    var lines = [];
    var temps = [];
    var hottest = null, coldest = null;

    for (var i = 0; i < region.cities.length; i++) {
        var city = region.cities[i];
        var ob = observations[city.station];
        if (!ob || ob.tempF == null) continue;
        var feelsLike = _compute_feels_like(ob.tempF, ob.dewF, ob.wspd);
        temps.push({ name: city.name, tempF: ob.tempF, dewF: ob.dewF, feelsLike: feelsLike, ob: ob });
        if (!hottest || ob.tempF > hottest.tempF) hottest = temps[temps.length - 1];
        if (!coldest || ob.tempF < coldest.tempF) coldest = temps[temps.length - 1];
    }

    if (!temps.length) return 'Current conditions data is temporarily unavailable for the ' + region.name + '.';

    var avgTemp = Math.round(temps.reduce(function (sum, t) { return sum + t.tempF; }, 0) / temps.length);
    var seasonalNote = '';
    if (avgTemp >= 90) seasonalNote = _pick_random(['Summer heat is in full force. ', 'The heat is on across the region. ', '']);
    else if (avgTemp >= 75) seasonalNote = _pick_random(['Warm conditions across the board. ', 'Pleasant warmth settling in. ', '']);
    else if (avgTemp <= 25) seasonalNote = _pick_random(['Winter\'s grip is firmly in place. ', 'Bundle up — it\'s frigid out there. ', '']);
    else if (avgTemp <= 40) seasonalNote = _pick_random(['A chilly pattern is holding. ', 'Cool air is in control. ', '']);

    lines.push(_pick_random([
        'Zooming into the ' + region.name + ' — here\'s what temperatures look like right now ' + tod + '.',
        'Let\'s check in on current conditions across the ' + region.name + ' ' + tod + '.',
        'Taking a closer look at surface temperatures across the ' + region.name + ' region.',
        'Here\'s a snapshot of current temperatures across the ' + region.name + ' ' + tod + '.',
        'Turning our attention to the thermometers across the ' + region.name + ' — let\'s see what folks are feeling right now.',
        'Time for a conditions check across the ' + region.name + '. Here\'s what the latest observations are showing.',
        'Let\'s see how temperatures are stacking up across the ' + region.name + ' ' + tod + '.'
    ]));

    if (seasonalNote) lines.push(seasonalNote);

    if (hottest && coldest && hottest.name !== coldest.name) {
        var spread = hottest.tempF - coldest.tempF;
        lines.push(_pick_random([
            hottest.name + ' is the warmest at ' + hottest.tempF + '°F while ' + coldest.name + ' sits at ' + coldest.tempF + '°F — a ' + spread + '-degree spread across the region.',
            'Currently ' + hottest.tempF + '°F in ' + hottest.name + ' and ' + coldest.tempF + '°F in ' + coldest.name + '.',
            'The range runs from ' + coldest.tempF + '°F in ' + coldest.name + ' up to ' + hottest.tempF + '°F in ' + hottest.name + ' — ' + spread + ' degrees of difference.',
            hottest.name + ' leads the pack at ' + hottest.tempF + '°F, while ' + coldest.name + ' is bringing up the rear at ' + coldest.tempF + '°F.',
            'Quite a contrast — ' + hottest.name + ' is sitting at ' + hottest.tempF + '°F and ' + coldest.name + ' is down at ' + coldest.tempF + '°F. That\'s a ' + spread + '-degree gap.',
            'Temperatures range from a ' + (coldest.tempF <= 32 ? 'frosty ' : '') + coldest.tempF + '°F in ' + coldest.name + ' to ' + (hottest.tempF >= 85 ? 'a toasty ' : '') + hottest.tempF + '°F in ' + hottest.name + '.'
        ]));
    }

    var bigFeelsDiff = temps.filter(function (t) { return t.feelsLike != null && Math.abs(t.feelsLike - t.tempF) >= 5; });
    if (bigFeelsDiff.length > 0) {
        var worst = bigFeelsDiff.sort(function (a, b) { return Math.abs(b.feelsLike - b.tempF) - Math.abs(a.feelsLike - a.tempF); })[0];
        var diff = worst.feelsLike - worst.tempF;
        if (diff > 0) {
            lines.push(_pick_random([
                'The heat index in ' + worst.name + ' pushes the feels-like temperature to ' + worst.feelsLike + '°F — that\'s ' + Math.abs(diff) + ' degrees above the actual reading. Humidity is a factor.',
                'It feels like ' + worst.feelsLike + '°F in ' + worst.name + ' thanks to the humidity, well above the actual ' + worst.tempF + '°F.',
                'Humidity is making ' + worst.name + ' feel like ' + worst.feelsLike + '°F — a full ' + Math.abs(diff) + ' degrees warmer than the thermometer reads.',
                worst.name + ' might say ' + worst.tempF + '°F on paper, but step outside and it feels like ' + worst.feelsLike + '°F with that moisture in the air.',
                'The humidity bump in ' + worst.name + ' is no joke — the heat index has it feeling like ' + worst.feelsLike + '°F versus an actual ' + worst.tempF + '°F.',
                'That Gulf moisture is pushing the feels-like in ' + worst.name + ' up to ' + worst.feelsLike + '°F. Stay hydrated out there.'
            ]));
        } else {
            lines.push(_pick_random([
                'Wind chill is dropping the feels-like temperature in ' + worst.name + ' down to ' + worst.feelsLike + '°F, ' + Math.abs(diff) + ' degrees below the actual air temperature.',
                'Factor in the wind and it feels like just ' + worst.feelsLike + '°F in ' + worst.name + ', noticeably colder than the ' + worst.tempF + '°F on the thermometer.',
                'The wind chill in ' + worst.name + ' drags it down to ' + worst.feelsLike + '°F — that\'s ' + Math.abs(diff) + ' degrees colder than the air temperature alone.',
                'Don\'t let the thermometer fool you in ' + worst.name + ' — with the wind, it feels like ' + worst.feelsLike + '°F out there.',
                worst.name + ' is dealing with a ' + Math.abs(diff) + '-degree wind chill bite, bringing the feels-like down to ' + worst.feelsLike + '°F.',
                'Exposed skin won\'t last long in ' + worst.name + ' ' + tod + ' — the wind chill makes it feel like ' + worst.feelsLike + '°F.'
            ]));
        }
    }

    var humid = temps.filter(function (t) { return t.dewF != null && t.dewF >= 65; });
    if (humid.length >= 2) {
        var humidNames = humid.slice(0, 3).map(function (t) { return t.name; });
        lines.push(_pick_random([
            'Dew points in the 60s and 70s across ' + humidNames.join(', ') + ' — that\'s oppressive moisture.',
            'Sticky air across ' + humidNames.join(' and ') + ' with elevated dew points making it feel much warmer.',
            'The moisture content is high across ' + humidNames.join(', ') + ' — dew points are well into the uncomfortable range.',
            'If you\'re in ' + humidNames.join(' or ') + ', the humidity is brutal. Dew points are in the mid-60s to 70s.',
            'Muggy conditions across ' + humidNames.join(' and ') + ' with dew points high enough to make even shade feel warm.'
        ]));
    }

    var windy = temps.filter(function (t) { return t.ob.wspd != null && t.ob.wspd >= 15; });
    if (windy.length > 0) {
        var windCity = windy[0];
        var windMph = Math.round(windCity.ob.wspd * 1.15078);
        lines.push(_pick_random([
            windCity.name + ' is seeing sustained winds around ' + windMph + ' mph.',
            'It\'s breezy in ' + windCity.name + ' with winds gusting to about ' + windMph + ' mph.',
            windCity.name + ' is dealing with ' + windMph + ' mph sustained winds ' + tod + ' — hold onto your hat.',
            'Winds are clipping along at ' + windMph + ' mph in ' + windCity.name + '.',
            'A brisk wind at ' + windMph + ' mph is making itself known in ' + windCity.name + ' ' + tod + '.'
        ]));
    }

    var funNote = _pick_random([
        '', '', '', '', '', '',
        ' Perfect weather to just stay inside and watch radar.',
        ' Not a bad time to check in on the forecast for the week ahead.',
        ' Always fun to see how temperatures paint across the map.'
    ]);
    if (funNote) lines.push(funNote);

    return lines.join(' ');
}

function _build_conditions_panel_html(regionName) {
    var html = '<div class="fnAlert" style="--fn-accent:#f59e0b">';
    html += '<div class="fnAlertShine"></div>';
    html += '<div class="fnAlertBody">';
    html += '<div class="fnAlertEventName">CURRENT TEMPERATURES</div>';
    html += '<div class="fnAlertSourceLine" style="margin-top:4px;opacity:0.75">' + regionName + '  ·  Temp / Feels Like</div>';
    html += '</div>';
    html += '</div>';
    return html;
}

var _lastConditionsRegionIdx = -1;

function _run_conditions_segment(resolve) {
    _currentSegmentType = 'conditions';
    _set_clock_mode('hidden');
    _hide_header_radar_info(null);

    var regionIdx;
    do {
        regionIdx = Math.floor(Math.random() * CONDITION_REGIONS.length);
    } while (regionIdx === _lastConditionsRegionIdx && CONDITION_REGIONS.length > 1);
    _lastConditionsRegionIdx = regionIdx;
    var region = CONDITION_REGIONS[regionIdx];

    _record_segment('conditions', region.name);

    _hide_all_map_overlays();
    _remove_static_mrms_layer();
    _show_info_panel(_build_conditions_panel_html(region.name));

    map.flyTo({ center: region.center, zoom: region.zoom, speed: 1.2, essential: true });

    _fetch_observations(function (observations) {
        if (!_active) { _show_all_map_overlays(); _show_header_radar_info(); _hide_cond_legend(); return resolve(); }

        var obsKeys = Object.keys(observations);
        if (obsKeys.length === 0) {
            console.warn('[LiveMode] Conditions segment: no observation data returned');
            _show_all_map_overlays();
            _show_header_radar_info();
            _hide_cond_legend();
            _hide_info_panel();
            return resolve();
        }

        _trackAlertTimer(function () {
            if (!_active) { _show_all_map_overlays(); _show_header_radar_info(); _hide_cond_legend(); return resolve(); }
            _add_conditions_layer(region, observations);
            _show_cond_legend();
            _typewrite(_generate_conditions_commentary(region, observations), 1200);

            _segmentTimer = setTimeout(function () {
                _wait_for_typewriter_then(function () {
                    _stop_typewriter();
                    _remove_conditions_layer();
                    _hide_cond_legend();
                    _show_all_map_overlays();
                    _show_header_radar_info();
                    _hide_info_panel();
                    resolve();
                });
            }, CONDITIONS_DURATION_MS);
        }, 300);
    });
}

// ── Earthquake Segment ──────────────────────────────────────────────────────

function _fetch_earthquakes(callback) {
    fetch(EARTHQUAKE_FEED_URL, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
            if (!data || !Array.isArray(data.features)) return callback([]);
            var usQuakes = data.features.filter(function (f) {
                if (!f.geometry || !f.geometry.coordinates) return false;
                var lng = f.geometry.coordinates[0];
                var lat = f.geometry.coordinates[1];
                return lat >= 24 && lat <= 50 && lng >= -125 && lng <= -66;
            });
            usQuakes.sort(function (a, b) { return (b.properties.time || 0) - (a.properties.time || 0); });
            callback(usQuakes);
        })
        .catch(function () { callback([]); });
}

function _mag_to_color(mag) {
    if (mag >= 5.0) return '#dc2626';
    if (mag >= 4.0) return '#f97316';
    if (mag >= 3.5) return '#eab308';
    if (mag >= 3.0) return '#a3e635';
    return '#60a5fa';
}

function _spread_nearby_points(points, thresholdDeg) {
    for (var i = 0; i < points.length; i++) {
        for (var j = i + 1; j < points.length; j++) {
            var dx = points[j][0] - points[i][0];
            var dy = points[j][1] - points[i][1];
            var dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < thresholdDeg) {
                var angle = Math.atan2(dy, dx);
                var nudge = (thresholdDeg - dist) / 2 + thresholdDeg * 0.3;
                points[j][0] += Math.cos(angle) * nudge;
                points[j][1] += Math.sin(angle) * nudge;
                points[i][0] -= Math.cos(angle) * nudge;
                points[i][1] -= Math.sin(angle) * nudge;
            }
        }
    }
}

function _add_earthquake_layer(quakes) {
    _remove_earthquake_layer();

    var coords_arr = [];
    for (var i = 0; i < quakes.length; i++) {
        var c = quakes[i].geometry.coordinates;
        coords_arr.push([c[0], c[1]]);
    }
    _spread_nearby_points(coords_arr, 0.6);

    var features = [];
    for (var i = 0; i < quakes.length; i++) {
        var q = quakes[i];
        var props = q.properties || {};
        var mag = props.mag || 0;
        var place = props.place || 'Unknown location';
        var depthKm = q.geometry.coordinates[2] ? Math.round(q.geometry.coordinates[2]) : 0;
        var ago = _time_ago(props.time);
        var label = 'M' + mag.toFixed(1) + '\n' + place.replace(/^.* of /, '');
        features.push(turf.point(coords_arr[i], {
            mag: mag,
            place: place,
            depth: depthKm,
            label: label,
            ago: ago,
            color: _mag_to_color(mag),
            radius: Math.max(6, mag * 5)
        }));
    }

    var fc = turf.featureCollection(features);

    map.addSource(LM_QUAKE_SOURCE, { type: 'geojson', data: fc });

    map.addLayer({
        id: LM_QUAKE_PULSE,
        type: 'circle',
        source: LM_QUAKE_SOURCE,
        paint: {
            'circle-radius': ['*', ['get', 'radius'], 2.5],
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.15,
            'circle-stroke-width': 0
        }
    });

    map.addLayer({
        id: LM_QUAKE_CIRCLE,
        type: 'circle',
        source: LM_QUAKE_SOURCE,
        paint: {
            'circle-radius': ['get', 'radius'],
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.85,
            'circle-stroke-width': 1.5,
            'circle-stroke-color': 'rgba(255,255,255,0.5)'
        }
    });

    map.addLayer({
        id: LM_QUAKE_LABEL,
        type: 'symbol',
        source: LM_QUAKE_SOURCE,
        layout: {
            'text-field': ['get', 'label'],
            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
            'text-size': 10,
            'text-line-height': 1.2,
            'text-anchor': 'top',
            'text-offset': [0, 1.4],
            'text-allow-overlap': false,
            'text-ignore-placement': false
        },
        paint: {
            'text-color': '#ffffff',
            'text-halo-color': 'rgba(0,0,0,0.8)',
            'text-halo-width': 1.5
        }
    });

    _quakePulseAnim = _animate_quake_pulse();
}

var _quakePulseAnim = null;

function _animate_quake_pulse() {
    var scale = 1.0;
    var growing = true;
    var id = setInterval(function () {
        if (!map.getLayer(LM_QUAKE_PULSE)) { clearInterval(id); return; }
        scale += growing ? 0.03 : -0.03;
        if (scale >= 1.5) growing = false;
        if (scale <= 1.0) growing = true;
        try {
            map.setPaintProperty(LM_QUAKE_PULSE, 'circle-opacity', 0.05 + (1.5 - scale) * 0.2);
        } catch (_) {}
    }, 60);
    return id;
}

function _remove_earthquake_layer() {
    if (_quakePulseAnim) { clearInterval(_quakePulseAnim); _quakePulseAnim = null; }
    try { if (map.getLayer(LM_QUAKE_LABEL)) map.removeLayer(LM_QUAKE_LABEL); } catch (_) {}
    try { if (map.getLayer(LM_QUAKE_CIRCLE)) map.removeLayer(LM_QUAKE_CIRCLE); } catch (_) {}
    try { if (map.getLayer(LM_QUAKE_PULSE)) map.removeLayer(LM_QUAKE_PULSE); } catch (_) {}
    try { if (map.getSource(LM_QUAKE_SOURCE)) map.removeSource(LM_QUAKE_SOURCE); } catch (_) {}
}

function _time_ago(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    var mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ' + (mins % 60) + 'm ago';
    return Math.floor(hrs / 24) + 'd ago';
}

function _generate_earthquake_commentary(quakes) {
    var lines = [];
    var tod = _time_of_day();

    if (quakes.length === 0) {
        return _pick_random([
            'No significant earthquakes detected across the continental U.S. in the last 24 hours. Seismically quiet day.',
            'The USGS reports no magnitude 2.5+ earthquakes within the lower 48 over the past day. All quiet on the seismic front.',
            'It\'s a calm day seismically — no M2.5 or greater earthquakes across the lower 48 in the past 24 hours.',
            'The seismographs have been quiet across the continental U.S. ' + tod + '. No noteworthy earthquake activity to report.',
            'No significant shaking to report ' + tod + '. The Earth is giving us a break across the lower 48.',
            'All quiet underground — the USGS hasn\'t recorded any M2.5+ events in the contiguous U.S. over the past day.',
            'The seismic picture is flat ' + tod + '. Not a single M2.5+ event across the continental United States in the last 24 hours.'
        ]);
    }

    lines.push(_pick_random([
        'Let\'s check in on recent seismic activity across the United States.',
        'Here\'s the latest earthquake activity reported by the USGS in the past 24 hours.',
        'Monitoring seismic events across the lower 48 — here\'s what the USGS is tracking right now.',
        'Shifting gears to earthquake activity ' + tod + '. The USGS has been tracking some seismic events across the country.',
        'Time to check the seismographs — here\'s the latest earthquake activity across the continental United States.',
        'Let\'s take a look at what\'s been shaking across the U.S. in the last 24 hours.',
        'From the weather to the ground beneath our feet — here\'s the recent seismic picture across the lower 48.'
    ]));

    var strongest = quakes[0];
    for (var i = 1; i < quakes.length; i++) {
        if (quakes[i].properties.mag > strongest.properties.mag) strongest = quakes[i];
    }
    var newest = quakes[0];

    var sMag = strongest.properties.mag;
    var sPlace = strongest.properties.place || 'an unknown location';
    var sDepth = strongest.geometry.coordinates[2] ? Math.round(strongest.geometry.coordinates[2]) : 0;

    if (sMag >= 4.5) {
        lines.push(_pick_random([
            'The most significant event is a magnitude ' + sMag.toFixed(1) + ' earthquake near ' + sPlace + '. That\'s strong enough to be widely felt and could cause minor damage.',
            'A notable M' + sMag.toFixed(1) + ' was recorded near ' + sPlace + ' — that\'s a significant shake.',
            'The standout event is an M' + sMag.toFixed(1) + ' near ' + sPlace + '. At this magnitude, people within dozens of miles likely felt it.',
            'We\'re looking at a magnitude ' + sMag.toFixed(1) + ' near ' + sPlace + ' — this is the kind of earthquake that gets attention. Shaking would have been felt over a wide area.',
            'An M' + sMag.toFixed(1) + ' struck near ' + sPlace + '. That\'s a significant event — strong enough to knock items off shelves and rattle nerves.',
            'The biggest quake on the board is an M' + sMag.toFixed(1) + ' near ' + sPlace + '. Anything above 4.5 can cause light damage to buildings in the epicentral area.'
        ]));
    } else if (sMag >= 3.5) {
        lines.push(_pick_random([
            'The largest event was a magnitude ' + sMag.toFixed(1) + ' near ' + sPlace + '. Likely felt by people nearby but unlikely to cause damage.',
            'An M' + sMag.toFixed(1) + ' was recorded near ' + sPlace + ' — noticeable to anyone in the immediate area.',
            'The strongest event is an M' + sMag.toFixed(1) + ' near ' + sPlace + '. People close to the epicenter probably felt a jolt, but structural damage is unlikely.',
            'We saw a magnitude ' + sMag.toFixed(1) + ' near ' + sPlace + '. That\'s enough to rattle windows and get the attention of anyone nearby.',
            'An M' + sMag.toFixed(1) + ' was picked up near ' + sPlace + ' — moderate magnitude. You\'d definitely notice it if you were sitting still indoors.',
            'The highlight is an M' + sMag.toFixed(1) + ' near ' + sPlace + '. At this magnitude, it\'s felt locally but shouldn\'t cause any real damage.'
        ]));
    } else {
        lines.push(_pick_random([
            'The strongest was an M' + sMag.toFixed(1) + ' near ' + sPlace + '. Minor activity — generally not felt.',
            'We saw an M' + sMag.toFixed(1) + ' near ' + sPlace + '. Small magnitude, mostly picked up by instruments.',
            'The largest event clocks in at M' + sMag.toFixed(1) + ' near ' + sPlace + '. At this size, it\'s really only detected by seismometers.',
            'An M' + sMag.toFixed(1) + ' near ' + sPlace + ' leads the list. Minor stuff — you\'d be hard-pressed to feel this one.',
            'The top event is a modest M' + sMag.toFixed(1) + ' near ' + sPlace + '. These micro-quakes happen constantly and go unnoticed by most people.',
            'We\'re seeing an M' + sMag.toFixed(1) + ' near ' + sPlace + ' as the largest. Nothing dramatic — the seismometers caught it, but most people wouldn\'t have.'
        ]));
    }

    if (sDepth > 0) {
        if (sDepth < 5) {
            lines.push(_pick_random([
                'At just ' + sDepth + ' km deep, this was a very shallow event — shallow quakes tend to produce stronger shaking at the surface.',
                'The ' + sDepth + ' km depth puts this very close to the surface. Shallow earthquakes like this are more likely to be felt even at lower magnitudes.',
                'This event was only ' + sDepth + ' km deep — extremely shallow, which amplifies the shaking effect for anyone above the epicenter.'
            ]));
        } else if (sDepth < 15) {
            lines.push(_pick_random([
                'The earthquake occurred at a depth of about ' + sDepth + ' km — relatively shallow in the Earth\'s crust.',
                'At ' + sDepth + ' km deep, this is a shallow crustal event, typical for tectonic activity in this part of the country.',
                'A depth of ' + sDepth + ' km keeps this in the shallow category, meaning surface effects are more pronounced than a deeper event of the same magnitude.'
            ]));
        } else if (sDepth >= 50) {
            lines.push(_pick_random([
                'This event was ' + sDepth + ' km deep — a deeper earthquake, which usually means less intense surface shaking despite the magnitude.',
                'At ' + sDepth + ' km, this is a deeper event. The energy has to travel through more rock before reaching the surface, spreading out the shaking.',
                'The ' + sDepth + ' km depth is notable — deep quakes are felt over a wider area but with less concentrated shaking at any one point.'
            ]));
        }
    }

    var sPlaceLower = sPlace.toLowerCase();
    if (sPlaceLower.indexOf('oklahoma') !== -1) {
        lines.push(_pick_random([
            'Oklahoma has seen a dramatic increase in seismicity over the past decade, largely linked to wastewater injection from oil and gas operations.',
            'Central Oklahoma remains one of the most seismically active regions in the country, much of it tied to induced seismicity from injection wells.',
            'Earthquake activity in Oklahoma has become a regular occurrence — most events there are attributed to deep wastewater disposal from energy production.'
        ]));
    } else if (sPlaceLower.indexOf('california') !== -1) {
        lines.push(_pick_random([
            'California sits along the San Andreas fault system, one of the most studied and closely monitored seismic zones in the world.',
            'Earthquake activity is par for the course in California, where the Pacific and North American plates are constantly grinding past each other.',
            'The Golden State is no stranger to earthquakes — California averages over 10,000 per year, though most are too small to feel.'
        ]));
    } else if (sPlaceLower.indexOf('yellowstone') !== -1 || sPlaceLower.indexOf('wyoming') !== -1) {
        lines.push(_pick_random([
            'The Yellowstone region sits atop one of the world\'s largest volcanic hotspots. Earthquake swarms there are common and closely monitored.',
            'Seismic activity near Yellowstone is always worth watching given the massive magma chamber below, though most events are routine.'
        ]));
    } else if (sPlaceLower.indexOf('tennessee') !== -1 || sPlaceLower.indexOf('missouri') !== -1 || sPlaceLower.indexOf('arkansas') !== -1) {
        lines.push(_pick_random([
            'This area is part of the New Madrid Seismic Zone — one of the most active fault systems east of the Rockies.',
            'The New Madrid fault zone runs through this region. It produced some of the strongest earthquakes in U.S. history back in 1811-1812.'
        ]));
    }

    if (quakes.length > 1) {
        lines.push(_pick_random([
            'In total, ' + quakes.length + ' earthquakes of magnitude 2.5 or greater have been recorded across the U.S. in the past 24 hours.',
            'The USGS has logged ' + quakes.length + ' seismic events M2.5+ in the continental U.S. today.',
            'Across the lower 48, the USGS recorded ' + quakes.length + ' earthquakes at M2.5 or above in the past day.',
            'That\'s ' + quakes.length + ' total events M2.5 or greater nationwide in the last 24 hours.',
            'All told, ' + quakes.length + ' seismic events made the M2.5+ threshold across the contiguous United States recently.',
            'The seismic tally stands at ' + quakes.length + ' events at M2.5 or greater across the lower 48 in the past day.'
        ]));
    }

    if (newest !== strongest) {
        var nMag = newest.properties.mag;
        var nPlace = newest.properties.place || 'an unknown location';
        var nAgo = _time_ago(newest.properties.time);
        lines.push('The most recent event was an M' + nMag.toFixed(1) + ' near ' + nPlace + ', recorded ' + nAgo + '.');
    }

    var feltCount = quakes.filter(function (q) { return q.properties.felt && q.properties.felt > 0; }).length;
    if (feltCount > 0) {
        lines.push(_pick_random([
            feltCount + ' of these events received "Did You Feel It?" reports from the public.',
            'The USGS received felt reports on ' + feltCount + ' of these quakes.',
            feltCount + ' quake' + (feltCount > 1 ? 's' : '') + ' generated "Did You Feel It?" responses — meaning people actually noticed the shaking.',
            'The public weighed in on ' + feltCount + ' of these events through the USGS "Did You Feel It?" system.',
            'Residents reported feeling ' + feltCount + ' of these earthquakes through the USGS crowd-sourced reporting tool.'
        ]));
    }

    var depths = quakes.map(function (q) { return q.geometry.coordinates[2] || 0; });
    var avgDepth = Math.round(depths.reduce(function (a, b) { return a + b; }, 0) / depths.length);
    if (avgDepth > 0) {
        lines.push(_pick_random([
            'Average depth of activity is about ' + avgDepth + ' km — ' + (avgDepth < 10 ? 'very shallow, which means they\'re more easily felt.' : 'a moderate depth for this region.'),
            'The average focal depth comes in around ' + avgDepth + ' km. ' + (avgDepth < 10 ? 'That\'s quite shallow — surface effects are more noticeable at these depths.' : 'A fairly typical depth for continental seismicity.'),
            'Depths are averaging about ' + avgDepth + ' km across these events. ' + (avgDepth < 10 ? 'Shallow activity like this tends to produce more noticeable shaking.' : 'That\'s a moderate depth — pretty standard for this type of seismicity.')
        ]));
    }

    return lines.join(' ');
}

function _build_earthquake_panel_html(quakes) {
    var count = quakes.length;
    var maxMag = 0;
    for (var i = 0; i < quakes.length; i++) {
        if (quakes[i].properties.mag > maxMag) maxMag = quakes[i].properties.mag;
    }
    var accentColor = _mag_to_color(maxMag);

    var html = '<div class="fnAlert" style="--fn-accent:' + accentColor + '">';
    html += '<div class="fnAlertShine"></div>';
    html += '<div class="fnAlertBody">';
    html += '<div class="fnAlertEventName">RECENT EARTHQUAKES</div>';
    html += '<div class="fnAlertSourceLine" style="margin-top:4px;opacity:0.75">' + count + ' event' + (count !== 1 ? 's' : '') + ' M2.5+ in past 24h</div>';
    if (maxMag > 0) {
        html += '<div class="fnAlertSourceLine" style="margin-top:2px;opacity:0.6">Strongest: M' + maxMag.toFixed(1) + '</div>';
    }
    html += '</div>';
    html += '</div>';
    return html;
}

function _show_eq_legend() {
    var $el = $('#lmEqLegend');
    if (!$el.length) return;
    $el.show();
    void $el[0].offsetWidth;
    $el.addClass('lmEqLegend-visible');
}

function _hide_eq_legend() {
    var $el = $('#lmEqLegend');
    $el.removeClass('lmEqLegend-visible');
    setTimeout(function () { $el.hide(); }, 400);
}

function _show_cond_legend() {
    var $el = $('#lmCondLegend');
    if (!$el.length) return;
    $el.show();
    void $el[0].offsetWidth;
    $el.addClass('lmCondLegend-visible');
}

function _hide_cond_legend() {
    var $el = $('#lmCondLegend');
    $el.removeClass('lmCondLegend-visible');
    setTimeout(function () { $el.hide(); }, 400);
}

function _run_earthquake_segment(resolve) {
    _currentSegmentType = 'earthquake';
    _record_segment('earthquake', 'earthquake');
    _set_clock_mode('hidden');
    _hide_header_radar_info(null);

    _hide_all_map_overlays();
    _remove_static_mrms_layer();
    _remove_conditions_layer();

    _fetch_earthquakes(function (quakes) {
        if (!_active) { _show_all_map_overlays(); _show_header_radar_info(); return resolve(); }

        if (quakes.length > 0) {
            var lngMin = 180, lngMax = -180, latMin = 90, latMax = -90;
            for (var q = 0; q < quakes.length; q++) {
                var c = quakes[q].geometry.coordinates;
                if (c[0] < lngMin) lngMin = c[0];
                if (c[0] > lngMax) lngMax = c[0];
                if (c[1] < latMin) latMin = c[1];
                if (c[1] > latMax) latMax = c[1];
            }
            map.fitBounds([[lngMin, latMin], [lngMax, latMax]], {
                padding: 80, maxZoom: 7, duration: 1800, essential: true
            });
        } else {
            map.flyTo({ center: CONUS_CENTER, zoom: 4.0, speed: 1.2, essential: true });
        }

        _show_info_panel(_build_earthquake_panel_html(quakes));
        _show_eq_legend();

        if (quakes.length === 0) {
            _typewrite(_generate_earthquake_commentary(quakes), 1200);
            _segmentTimer = setTimeout(function () {
                _wait_for_typewriter_then(function () {
                    _stop_typewriter();
                    _show_all_map_overlays();
                    _show_header_radar_info();
                    _hide_eq_legend();
                    _hide_info_panel();
                    resolve();
                });
            }, 12000);
            return;
        }

        _trackAlertTimer(function () {
            if (!_active) { _show_all_map_overlays(); _show_header_radar_info(); _hide_eq_legend(); return resolve(); }
            _add_earthquake_layer(quakes);

            var strongest = quakes[0];
            for (var j = 1; j < quakes.length; j++) {
                if (quakes[j].properties.mag > strongest.properties.mag) strongest = quakes[j];
            }

            _typewrite(_generate_earthquake_commentary(quakes), 1200);

            _segmentTimer = setTimeout(function () {
                _wait_for_typewriter_then(function () {
                    if (!_active) {
                        _stop_typewriter();
                        _remove_earthquake_layer();
                        _show_all_map_overlays();
                        _show_header_radar_info();
                        _hide_eq_legend();
                        _hide_info_panel();
                        return resolve();
                    }

                    var sCoords = strongest.geometry.coordinates;
                    map.flyTo({
                        center: [sCoords[0], sCoords[1]],
                        zoom: 7,
                        speed: 0.8,
                        essential: true
                    });

                    _segmentTimer = setTimeout(function () {
                        _stop_typewriter();
                        _remove_earthquake_layer();
                        _show_all_map_overlays();
                        _show_header_radar_info();
                        _hide_eq_legend();
                        _hide_info_panel();
                        resolve();
                    }, 8000);
                });
            }, EARTHQUAKE_DURATION_MS / 2);
        }, 300);
    });
}

// ── Overlay UI ───────────────────────────────────────────────────────────────

function _show_overlay() {
    $('body').addClass('liveMode-active');
    $('#liveModeOverlay').show().addClass('liveModeOverlay-active');
    $('#map').css({ bottom: 0 });
    map.resize();
}

function _hide_overlay() {
    $('body').removeClass('liveMode-active');
    $('#liveModeOverlay').removeClass('liveModeOverlay-active').hide();
    _hide_info_panel();
    _hide_commentary_box();
    $('#map').css({ bottom: '' });
    map.resize();
}

function _flash_transition() {
    var $flash = $('#lmTransitionFlash');
    $flash.removeClass('lmTransitionFlash-active');
    void $flash[0]?.offsetWidth;
    $flash.addClass('lmTransitionFlash-active');
}

function _show_segment_label() {}
function _hide_segment_label() {}

var _infoPanelFadeTimer = null;

function _show_info_panel(html) {
    if (_infoPanelFadeTimer) { clearTimeout(_infoPanelFadeTimer); _infoPanelFadeTimer = null; }
    var $p = $('#liveModeInfoPanel');
    $p.removeClass('liveModeInfoPanel-fading');
    $p.html(html).addClass('liveModeInfoPanel-visible');
}

function _hide_info_panel() {
    if (_infoPanelFadeTimer) { clearTimeout(_infoPanelFadeTimer); _infoPanelFadeTimer = null; }
    _hide_commentary_box();
    var $p = $('#liveModeInfoPanel');
    if (!$p.hasClass('liveModeInfoPanel-visible')) { $p.html(''); return; }
    $p.addClass('liveModeInfoPanel-fading');
    _infoPanelFadeTimer = setTimeout(function () {
        $p.removeClass('liveModeInfoPanel-visible liveModeInfoPanel-fading').html('');
        _infoPanelFadeTimer = null;
    }, 550);
}

// ── Segment Picker ───────────────────────────────────────────────────────────

function _pick_next_segment() {
    var alerts = _get_active_severe_alerts();
    var allAlertData = window.stormTrackData?.alerts_data;
    var totalAlerts = allAlertData?.features?.length || 0;
    var hasAnySevere = alerts.length > 0;
    var tornadoCount = 0;
    for (var t = 0; t < alerts.length; t++) {
        if (TORNADO_EVENTS.includes(alerts[t]?.properties?.event)) tornadoCount++;
    }

    var hour = new Date().getHours();
    var isNight = hour >= 22 || hour < 6;
    var isPeakWx = hour >= 14 && hour <= 22;

    var options = [];

    options.push({ type: 'spc', weight: 3 });
    options.push({ type: 'conus', weight: 2 });
    options.push({ type: 'spotlight', weight: 4 });
    options.push({ type: 'conditions', weight: 3 });
    options.push({ type: 'earthquake', weight: 2 });

    if (hasAnySevere) {
        var alertWeight = 5 + alerts.length * 2;
        if (tornadoCount > 0) alertWeight += tornadoCount * 3;
        options.push({ type: 'alert', weight: alertWeight });
    }

    // Active severe weather — focus heavily on alerts and radar
    if (alerts.length >= 3) {
        for (var k = 0; k < options.length; k++) {
            if (options[k].type === 'conditions') options[k].weight = 1;
            if (options[k].type === 'earthquake') options[k].weight = 1;
            if (options[k].type === 'spotlight') options[k].weight = 2;
            if (options[k].type === 'conus') options[k].weight += 2;
        }
    }

    // Quiet weather — diversify content
    if (!hasAnySevere) {
        for (var i = 0; i < options.length; i++) {
            if (options[i].type === 'spotlight') options[i].weight += 2;
            if (options[i].type === 'conditions') options[i].weight += 2;
            if (options[i].type === 'conus') options[i].weight += 1;
            if (options[i].type === 'earthquake') options[i].weight += 1;
        }
    }

    // Peak weather hours — boost radar-heavy segments
    if (isPeakWx && totalAlerts > 0) {
        for (var p = 0; p < options.length; p++) {
            if (options[p].type === 'spotlight') options[p].weight += 2;
            if (options[p].type === 'conus') options[p].weight += 1;
        }
    }

    // Nighttime — conditions and SPC less interesting, boost conus overview
    if (isNight) {
        for (var n = 0; n < options.length; n++) {
            if (options[n].type === 'conditions') options[n].weight = Math.max(1, options[n].weight - 1);
            if (options[n].type === 'conus') options[n].weight += 1;
        }
    }

    // Penalize any segment that appeared in the last 3 plays
    for (var d = 0; d < options.length; d++) {
        var recentCount = _recent_type_count(options[d].type, 4);
        if (recentCount >= 2) options[d].weight = Math.max(1, Math.floor(options[d].weight / 3));
        else if (recentCount === 1) options[d].weight = Math.max(1, Math.floor(options[d].weight * 0.6));
    }

    // Hard block: never repeat the same segment type back-to-back
    var last = _recentSegments.length ? _recentSegments[_recentSegments.length - 1].type : null;
    // Also block the second-to-last to prevent A-B-A-B patterns
    var secondLast = _recentSegments.length >= 2 ? _recentSegments[_recentSegments.length - 2].type : null;
    if (last && options.length > 2) {
        var filtered = options.filter(function (o) {
            if (o.type === last) return false;
            if (o.type === secondLast) return false;
            return true;
        });
        if (filtered.length > 0) options = filtered;
        else {
            options = options.filter(function (o) { return o.type !== last; });
        }
    }

    if (!options.length) {
        options = [{ type: 'spc', weight: 1 }, { type: 'conus', weight: 1 }, { type: 'spotlight', weight: 2 }, { type: 'conditions', weight: 1 }, { type: 'earthquake', weight: 1 }];
        if (hasAnySevere) options.push({ type: 'alert', weight: 3 });
    }

    return _weighted_pick(options);
}

// ── Director Loop ────────────────────────────────────────────────────────────

function _full_segment_cleanup() {
    _alertEpoch++;
    _cancelAllAlertTimers();
    _clear_segment_timer();
    _stop_typewriter();
    _cleanup_loop_listener();
    _cleanup_scan_load_listener();
    _remove_focus_glow();
    _remove_storm_track();
    _remove_spc_layers();
    _remove_static_mrms_layer();
    _remove_conditions_layer();
    _remove_earthquake_layer();
    _show_all_map_overlays();
    _show_header_radar_info();
    _hide_eq_legend();
    _hide_cond_legend();
    _hide_info_panel();
    _hide_segment_label();

    var controller = window.stormTrackData?.radarLoopController;
    if (controller) {
        try { controller.stop(); } catch (_) {}
        controller.state.frames = [];
        controller.state.currentFrameIndex = 0;
    }
}

function _run_next() {
    if (!_active) return;

    var type = _pick_next_segment();
    _flash_transition();
    _show_segment_label(type);

    function advance() {
        if (!_active) return;
        _full_segment_cleanup();
        setTimeout(_run_next, 600);
    }

    if (type === 'spc') {
        _run_spc_segment(advance);
    } else if (type === 'alert') {
        _run_alert_segment(advance);
    } else if (type === 'spotlight') {
        _run_spotlight_segment(advance);
    } else if (type === 'conditions') {
        _run_conditions_segment(advance);
    } else if (type === 'earthquake') {
        _run_earthquake_segment(advance);
    } else {
        _run_conus_segment(advance);
    }
}

function _clear_segment_timer() {
    if (_segmentTimer) {
        clearTimeout(_segmentTimer);
        _segmentTimer = null;
    }
}

// ── Tornado Interrupt ────────────────────────────────────────────────────────

function _on_tornado_interrupt(e) {
    if (!_active) return;
    var detail = e?.detail;
    if (!detail) return;

    var eventName = detail.event || '';
    if (!TORNADO_EVENTS.includes(eventName)) return;
    if (detail.type !== 'new') return;

    // Find the actual tornado warning feature from alert data
    var alerts = _get_active_severe_alerts();
    var torFeature = null;
    for (var i = 0; i < alerts.length; i++) {
        if (TORNADO_EVENTS.includes(alerts[i]?.properties?.event)) {
            torFeature = alerts[i];
            break;
        }
    }
    if (!torFeature) return;

    _abort_current_segment();
    _run_alert_segment(function () {
        if (_active) _trackAlertTimer(_run_next, 600);
    }, torFeature);
}

function _abort_current_segment() {
    _full_segment_cleanup();
}

// ── State Save / Restore ─────────────────────────────────────────────────────

function _save_state() {
    var controller = window.stormTrackData?.radarLoopController;
    var loopState = controller?.state || {};
    _preSaveState = {
        station: window.stormTrackData?.currentStation || null,
        bounds: null,
        frameCount: loopState.frameCount || 14,
        speed: loopState.speedMultiplier || 5,
        product: window.stormTrackData?.product || 'ref'
    };
    try { _preSaveState.bounds = map.getBounds(); } catch (_) {}
}

function _restore_state() {
    if (!_preSaveState) return;

    _remove_static_mrms_layer();
    _remove_earthquake_layer();
    _ensure_single_site_mode();

    var savedProduct = _preSaveState.product || 'ref';
    var $prodRow = $('.psmRow[value="' + savedProduct + '"]').first();
    if ($prodRow.length) $prodRow.trigger('click');

    if (_preSaveState.station && nexrad_locations[_preSaveState.station]) {
        var loc = nexrad_locations[_preSaveState.station];
        station_markers.selectStation(_preSaveState.station, loc.type || 'WSR-88D');
    }

    if (_preSaveState.bounds) {
        try { map.fitBounds(_preSaveState.bounds, { padding: 0, duration: 800 }); } catch (_) {}
    }

    var controller = window.stormTrackData?.radarLoopController;
    if (controller) {
        controller.set_speed(_preSaveState.speed);
        controller.set_frame_count(_preSaveState.frameCount);
    }

    _preSaveState = null;
}

// ── Map Interaction Lock ─────────────────────────────────────────────────────

function _lock_map() {
    if (!map) return;
    map.boxZoom.disable();
    map.scrollZoom.disable();
    map.dragPan.disable();
    map.dragRotate.disable();
    map.keyboard.disable();
    map.doubleClickZoom.disable();
    map.touchZoomRotate.disable();
    try { map.touchPitch.disable(); } catch (_) {}
    map.getCanvas().style.cursor = 'default';
}

function _unlock_map() {
    if (!map) return;
    map.boxZoom.enable();
    map.scrollZoom.enable();
    map.dragPan.enable();
    map.dragRotate.enable();
    map.keyboard.enable();
    map.doubleClickZoom.enable();
    map.touchZoomRotate.enable();
    try { map.touchPitch.enable(); } catch (_) {}
    map.getCanvas().style.cursor = '';
}

// ── Public API ───────────────────────────────────────────────────────────────

function enable() {
    if (_active) return;
    _active = true;
    _recentSegments = [];

    _save_state();
    _show_overlay();
    _lock_map();

    _tornadoInterruptListener = _on_tornado_interrupt;
    window.addEventListener('alertNotification', _tornadoInterruptListener);

    _escapeListener = function (e) {
        if (e.key === 'Escape') disable();
    };
    document.addEventListener('keydown', _escapeListener);

    window.stormTrackData.liveModeActive = true;

    var updater = window.stormTrackData?.current_RadarUpdater;
    if (updater) updater.disable();

    setTimeout(_run_next, 800);
}

function disable() {
    if (!_active) return;
    _active = false;
    window.stormTrackData.liveModeActive = false;

    stopMusic();
    _abort_current_segment();
    _show_header_radar_info();
    _set_clock_mode('both');
    _hide_overlay();
    _unlock_map();
    _restore_state();

    var updater = window.stormTrackData?.current_RadarUpdater;
    if (updater) updater.enable();

    if (_tornadoInterruptListener) {
        window.removeEventListener('alertNotification', _tornadoInterruptListener);
        _tornadoInterruptListener = null;
    }
    if (_escapeListener) {
        document.removeEventListener('keydown', _escapeListener);
        _escapeListener = null;
    }

    $('#armrLiveModeBtnSwitchElem').prop('checked', false);
    settings_store.saveFromDom();
}

function isActive() {
    return _active;
}

// ── Background Music Player ─────────────────────────────────────────────────

var _MUSIC_TRACKS = [
    'music/bankside_breeze.mp3',
    'music/bread_oven_breeze.mp3',
    'music/city_sleeps.mp3',
    'music/creaking_hull.mp3',
    'music/crooked_fiddle.mp3',
    'music/fields_at_dusk.mp3',
    'music/forgotten_isle.mp3',
    'music/mug_and_melody.mp3',
    'music/old_magic.mp3',
    'music/runes_in_rain.mp3',
    'music/tavern_table_tap.mp3',
    'music/welcome_back.mp3'
];

var _musicAudio = null;
var _musicPlaying = false;
var _musicVolume = 0.15;
var _musicShuffled = [];
var _musicIndex = 0;

function _shuffle_tracks() {
    _musicShuffled = _MUSIC_TRACKS.slice().sort(function () { return Math.random() - 0.5; });
    _musicIndex = 0;
}

function _play_next_track() {
    if (!_musicPlaying) return;
    if (_musicIndex >= _musicShuffled.length) {
        _shuffle_tracks();
    }
    var src = _musicShuffled[_musicIndex++];
    if (_musicAudio) {
        try { _musicAudio.pause(); } catch (_) {}
        _musicAudio = null;
    }
    _musicAudio = new Audio(src);
    _musicAudio.volume = _musicVolume;
    _musicAudio.addEventListener('ended', function () {
        _play_next_track();
    });
    _musicAudio.addEventListener('error', function () {
        console.warn('[LiveMode Music] Failed to load:', src);
        setTimeout(function () { _play_next_track(); }, 1000);
    });
    var p = _musicAudio.play();
    if (p && p.catch) p.catch(function (e) {
        console.warn('[LiveMode Music] Play blocked:', e.message);
    });
}

function startMusic() {
    if (_musicPlaying) return;
    _musicPlaying = true;
    var saved = settings_store.load();
    _musicVolume = (saved.liveModeVolume || 15) / 100;
    _shuffle_tracks();

    function _attempt() {
        if (!_musicPlaying) return;
        _play_next_track();
    }

    if (_musicAudio === null && typeof document !== 'undefined') {
        var resumeOnGesture = function () {
            document.removeEventListener('click', resumeOnGesture);
            document.removeEventListener('keydown', resumeOnGesture);
            if (_musicPlaying && (!_musicAudio || _musicAudio.paused)) {
                _play_next_track();
            }
        };
        _attempt();
        if (_musicAudio && _musicAudio.paused) {
            document.addEventListener('click', resumeOnGesture);
            document.addEventListener('keydown', resumeOnGesture);
        }
    } else {
        _attempt();
    }
}

function stopMusic() {
    _musicPlaying = false;
    if (_musicAudio) {
        try { _musicAudio.pause(); } catch (_) {}
        _musicAudio = null;
    }
}

function setMusicVolume(pct) {
    _musicVolume = Math.max(0, Math.min(1, pct / 100));
    if (_musicAudio) _musicAudio.volume = _musicVolume;
}

function forceSegment(type) {
    if (!_active) {
        enable();
    }
    _abort_current_segment();
    _flash_transition();
    _show_segment_label(type);

    function advance() {
        if (!_active) return;
        _clear_segment_timer();
        _hide_segment_label();
        _trackAlertTimer(_run_next, 600);
    }

    if (type === 'spc') _run_spc_segment(advance);
    else if (type === 'alert') _run_alert_segment(advance);
    else if (type === 'spotlight') _run_spotlight_segment(advance);
    else if (type === 'conditions') _run_conditions_segment(advance);
    else if (type === 'earthquake') _run_earthquake_segment(advance);
    else if (type === 'conus') _run_conus_segment(advance);
    else return false;
    return true;
}

module.exports = { enable, disable, isActive, startMusic, stopMusic, setMusicVolume, forceSegment };
