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
const ut = require('../core/utils');
const settings_store = require('../core/menu/settings_store');
const alert_helpers = require('../alerts/alert_helpers');
const alerts_display_state = require('../alerts/alerts_display_state');
const filter_alerts = require('../alerts/filter_alerts');
const get_polygon_colors = require('../alerts/colors/polygon_colors');
const station_markers = require('../radar/station_markers/station_markers');
const lightning = require('../lightning/lightning');
const {
    NEXRAD_LOCATIONS: nexrad_locations,
    get_station_timezone
} = require('../radar/libnexrad/nexrad_locations');
const LiveModeHeaderController = require('./live_mode_header_controller');
const LiveModeMusicController = require('./live_mode_music_controller');
const LiveModeCommentator = require('./live_mode_commentator');

// ── Constants ────────────────────────────────────────────────────────────────

const SPC_BASE_URL = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/MapServer';
const DAY1_LAYERS = { categorical: 1, tornado: 3, hail: 5, wind: 7 };
const SPC_HAZARDS = ['categorical', 'tornado', 'wind', 'hail'];
let _spcOverlayCanvas = null;
let _spcOverlayCtx = null;
let _spcRenderListener = null;
let _spcRegularFeatures = [];
let _spcHatchedFeatures = [];
let _spcCigFeatures = [];

const CONUS_CENTER = [-98.5606744, 39.5];
const CONUS_ZOOM = 4.3;

const TORNADO_EVENTS = ['Tornado Warning', 'PDS Tornado Warning', 'Tornado Emergency'];
const SEVERE_ALERT_EVENTS = [
    'Tornado Emergency', 'PDS Tornado Warning', 'Tornado Warning',
    'Severe Thunderstorm Warning', 'Flash Flood Warning',
    'Evacuation - Immediate', 'Special Weather Statement'
];

const SPC_SEGMENT_DURATION_MS = 18000;
const ALERT_SEGMENT_DURATION_MS = 25000;
const MAX_TORNADO_FOCUS_STREAK = 2;
const ALERT_CLASS_FAIRNESS_RAMP_MIN = 6;
const ALERT_CLASS_FAIRNESS_BONUS_MAX = 28;
const ALERT_TORNADO_EXPIRE_SOON_MIN = 5;
const CONUS_SEGMENT_DURATION_MS = 28000;
const CONUS_OVERVIEW_SHARE = 10 / 28;
const CONUS_REGION_FOCUS_COUNT = 3;
const CONUS_REGION_MIN_DWELL_MS = 2400;
const CONUS_REGION_EXTRA_ZOOM = 0.3;
const CONUS_MRMS_REVEAL_TIMEOUT_MS = 1400;
const CONUS_SEVERE_FOCUS_REGIONS = [
    { name: 'Southern Plains', center: [-98.4, 34.1], zoom: 5.85 },
    { name: 'Mid-South', center: [-90.4, 35.2], zoom: 5.8 },
    { name: 'Dixie Alley', center: [-87.2, 33.3], zoom: 5.75 },
    { name: 'Central Plains', center: [-97.6, 39.4], zoom: 5.65 },
    { name: 'Upper Midwest', center: [-93.8, 43.8], zoom: 5.5 }
];
const SPOTLIGHT_DURATION_MS = 20000;
const VELOCITY_HOLD_MS = 8000;
const VELOCITY_LOAD_TIMEOUT_MS = 2200;
const PLAYBACK_LOOP_TARGET = 8;
const PLAYBACK_SPEED = 10;
const PLAYBACK_FRAME_COUNT = 14;
const SPOTLIGHT_FORECAST_CACHE_TTL_MS = 8 * 60 * 1000;
const STORM_REPORTS_SEGMENT_DURATION_MS = 17000;
const SPC_TODAY_REPORTS_URL = 'https://www.spc.noaa.gov/climo/reports/today.html';
const SPC_TODAY_REPORT_CSV_DEFAULT_URLS = {
    tornado: 'https://www.spc.noaa.gov/climo/reports/today_torn.csv',
    hail: 'https://www.spc.noaa.gov/climo/reports/today_hail.csv',
    wind: 'https://www.spc.noaa.gov/climo/reports/today_wind.csv'
};
const SPC_REPORTS_PROXY_PREFIX = 'https://corsproxy.io/?url=';

const EARTHQUAKE_DURATION_MS = 22000;
const EARTHQUAKE_FEED_URL = '/api/earthquakes';
const LM_QUAKE_SOURCE = 'lmQuakeSource';
const LM_QUAKE_CIRCLE = 'lmQuakeCircle';
const LM_QUAKE_LABEL = 'lmQuakeLabel';
const LM_QUAKE_PULSE = 'lmQuakePulse';
const LM_STORM_REPORTS_SOURCE = 'lmStormReportsSource';
const LM_STORM_REPORTS_LAYER = 'lmStormReportsLayer';
const LM_STORM_REPORTS_SIG_LAYER = 'lmStormReportsSigLayer';

const SEGMENT_WEIGHTS = { spc: 3, alert: 5, conus: 2, spotlight: 4, conditions: 3, storm_reports: 3, earthquake: 2 };
const ALERT_CATEGORY_ICON_META = {
    'Severe Weather': { icon: 'fa-bolt-lightning' },
    'Winter': { icon: 'fa-snowflake' },
    'Fire': { icon: 'fa-fire' },
    'Marine': { icon: 'fa-water' },
    'Flood': { icon: 'fa-house-flood-water' },
    'Tropical': { icon: 'fa-hurricane' },
    'Other': { icon: 'fa-triangle-exclamation' },
    'Watches': { icon: 'fa-eye' }
};

// ── State ────────────────────────────────────────────────────────────────────

let _active = false;
let _segmentTimer = null;
let _currentSegmentType = null;
let _spotlightForecastRequestEpoch = 0;
let _spotlightForecastCache = {};

let _preSaveState = null;
let _recentSegments = [];
let _alertVisitHistory = Object.create(null);
let _alertFocusClassHistory = Object.create(null);
let _consecutiveTornadoFocusCount = 0;
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
let _spcLegendHideTimer = null;
let _sweepBaseSelectionListener = null;
let _sweepBaseLoadedListener = null;
let _nonSiteGuardTimer = null;
let _preLiveModeAlertBlinkEnabled;
let _preLiveModeAlertBlinkCaptured = false;

const LM_FOCUS_SOURCE = 'lmFocusGlowSource';
const LM_FOCUS_GLOW_OUTER = 'lmFocusGlowOuter';
const LM_FOCUS_GLOW_INNER = 'lmFocusGlowInner';

const LM_TRACK_SOURCE = 'lmStormTrackSource';
const LM_TRACK_LINE_LAYER = 'lmStormTrackLine';
const LM_TRACK_ARROW_LAYER = 'lmStormTrackArrow';

const MAPBOX_TOKEN = 'pk.eyJ1IjoidHdhbGtlcjkyIiwiYSI6ImNtZDkwaHMwdTAyazkya3BzNXphYWI3a2kifQ.sWYO653OYlYHYc_wOHsd2A';
const NWS_UA = '(Vortex Radar, https://vortexradar.snapsera.com)';

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
    const params = _parse_alert_params(feature);
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

const _headerController = new LiveModeHeaderController();
var _clockMode = 'both';
var _clockSuppressed = false;

function _apply_clock_mode() {
    _headerController.setClockMode(_clockSuppressed ? 'hidden' : _clockMode);
}

function _set_clock_mode(mode) {
    _clockMode = mode || 'both';
    _apply_clock_mode();
}

function _set_clock_suppressed(suppressed) {
    _clockSuppressed = !!suppressed;
    _apply_clock_mode();
}

// ── Header Radar Info Control ────────────────────────────────────────────────

function _hide_header_radar_info(riskLabel, options) {
    _headerController.hideRadarInfo(riskLabel, options);
}

function _show_header_radar_info(options) {
    var force = !!(options && options.force);
    if (!force && _active && !_segment_allows_site_radar()) {
        _hide_header_radar_info(null, { allowSocialFallback: true });
        return;
    }
    _headerController.showRadarInfo();
}

function _classify_risk(props) {
    return _headerController.classifyRisk(props);
}

function _build_risk_label(geojson) {
    return _headerController.buildRiskLabel(geojson);
}

// ── Storm Motion Parsing ─────────────────────────────────────────────────────

function _extract_storm_motion(feature) {
    var p = feature?.properties || {};
    var desc = p.description || '';
    var speedMph = null;
    var bearingDeg = null;
    var stormLat = null;
    var stormLon = null;

    function _normalize_bearing(deg) {
        if (!Number.isFinite(deg)) return null;
        var normalized = deg % 360;
        return normalized < 0 ? normalized + 360 : normalized;
    }

    function _bearing_delta(a, b) {
        if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
        var d = Math.abs(_normalize_bearing(a) - _normalize_bearing(b));
        return d > 180 ? 360 - d : d;
    }

    function _is_valid_lat_lon(lat, lon) {
        return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    }

    function _parse_tml_coord(token, isLon) {
        if (!token) return null;
        var txt = String(token).trim();
        if (!txt) return null;
        var val = parseFloat(txt);
        if (!Number.isFinite(val)) return null;
        if (txt.indexOf('.') === -1 && Math.abs(val) > 180) val = val / 100;
        if (isLon && val > 0) val = -val;
        return val;
    }

    function _parse_speed_mph(rawSpeed, unit) {
        var sp = parseInt(rawSpeed, 10);
        if (!Number.isFinite(sp)) return null;
        var u = (unit || 'mph').toLowerCase();
        return u === 'mph' ? sp : Math.round(sp * 1.15078);
    }

    var descMoveBearing = null;
    var descMoveSpeedMph = null;
    var movePat = /MOVING\s+([A-Z\-\s]+?)\s+AT\s+(\d{1,3})\s*(MPH|KT|KTS|KNOTS?)/i;
    var moveMatch = desc.match(movePat);
    if (moveMatch) {
        var dirStr = moveMatch[1].toLowerCase().replace(/\s+/g, '');
        if (DIR_MAP[dirStr] != null) descMoveBearing = DIR_MAP[dirStr];
        descMoveSpeedMph = _parse_speed_mph(moveMatch[2], moveMatch[3]);
    }

    var tml = desc.match(/TIME\.\.\.MOT\.\.\.LOC\s+\d{4}Z?\s+(\d{3})DEG\s+(\d{1,3})\s*(MPH|KT|KTS|KNOTS?)\s+([-\d.]+)\s+([-\d.]+)/i);
    if (tml) {
        var rawTmlBearing = parseInt(tml[1], 10);
        if (Number.isFinite(rawTmlBearing)) {
            var tmlToward = _normalize_bearing(rawTmlBearing + 180);
            var tmlFrom = _normalize_bearing(rawTmlBearing);
            if (descMoveBearing != null) {
                bearingDeg = _bearing_delta(tmlToward, descMoveBearing) <= _bearing_delta(tmlFrom, descMoveBearing)
                    ? tmlToward
                    : tmlFrom;
            } else {
                // TIME...MOT...LOC vectors are typically "from" bearings in NWS text.
                bearingDeg = tmlToward;
            }
        }
        speedMph = _parse_speed_mph(tml[2], tml[3]);

        var parsedLat = _parse_tml_coord(tml[4], false);
        var parsedLon = _parse_tml_coord(tml[5], true);
        if (_is_valid_lat_lon(parsedLat, parsedLon)) {
            stormLat = parsedLat;
            stormLon = parsedLon;
        }
    }

    if (bearingDeg == null && descMoveBearing != null) bearingDeg = descMoveBearing;
    if (speedMph == null && descMoveSpeedMph != null) speedMph = descMoveSpeedMph;

    if (speedMph == null) {
        var speedOnlyPatterns = [
            /moving\s+[a-z\-\s]+?\s+at\s+(\d{1,3})\s*(mph|kt|kts|knot|knots)\b/i,
            /moving\s+at\s+(\d{1,3})\s*(mph|kt|kts|knot|knots)\b/i
        ];
        for (var pi = 0; pi < speedOnlyPatterns.length; pi++) {
            var mm = desc.match(speedOnlyPatterns[pi]);
            if (mm && mm[1]) {
                speedMph = _parse_speed_mph(mm[1], mm[2]);
                if (speedMph != null) break;
            }
        }
    }

    if (bearingDeg == null) {
        var dirOnly = desc.match(/MOVING\s+([A-Z\-\s]+)/i);
        if (dirOnly) {
            var dk = dirOnly[1].toLowerCase().replace(/\s+/g, '');
            if (DIR_MAP[dk] != null) bearingDeg = DIR_MAP[dk];
        }
    }

    if (!_is_valid_lat_lon(stormLat, stormLon) && feature.geometry) {
        try {
            var c = turf.centroid(turf.feature(feature.geometry));
            stormLat = c.geometry.coordinates[1];
            stormLon = c.geometry.coordinates[0];
        } catch (_) {}
    }

    if (bearingDeg == null || speedMph == null) return null;
    return { bearingDeg: bearingDeg, speedMph: speedMph, stormLat: stormLat, stormLon: stormLon };
}

function _get_alert_category_for_banner(eventName) {
    var resolved = eventName === 'Tornado Emergency' || eventName === 'PDS Tornado Warning'
        ? 'Tornado Warning'
        : eventName;
    var categories = alerts_display_state?.ALERT_TYPES_BY_CATEGORY || {};
    for (var category in categories) {
        if (!Object.prototype.hasOwnProperty.call(categories, category)) continue;
        var events = categories[category] || [];
        if (events.indexOf(resolved) !== -1) return category;
    }
    return 'Other';
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

function _city_path_metrics(motion, city) {
    if (!motion || !city || motion.stormLat == null || city.lat == null || city.lng == null) return null;
    try {
        var distMiles = turf.distance(
            turf.point([motion.stormLon, motion.stormLat]),
            turf.point([city.lng, city.lat]),
            { units: 'miles' }
        );
        if (!Number.isFinite(distMiles)) return null;
        var cityBearing = turf.bearing(
            turf.point([motion.stormLon, motion.stormLat]),
            turf.point([city.lng, city.lat])
        );
        var deltaDeg = ((cityBearing - motion.bearingDeg + 540) % 360) - 180;
        var deltaRad = deltaDeg * Math.PI / 180;
        var alongMiles = distMiles * Math.cos(deltaRad);
        var crossMiles = Math.abs(distMiles * Math.sin(deltaRad));
        return { distMiles: distMiles, alongMiles: alongMiles, crossMiles: crossMiles };
    } catch (_) { return null; }
}

function _collect_geometry_points(feature) {
    var geom = feature?.geometry;
    var out = [];
    if (!geom || !geom.type || !Array.isArray(geom.coordinates)) return out;
    if (geom.type === 'Polygon') {
        for (var ri = 0; ri < geom.coordinates.length; ri++) {
            var ring = geom.coordinates[ri] || [];
            for (var pi = 0; pi < ring.length; pi++) {
                var pt = ring[pi];
                if (Array.isArray(pt) && pt.length >= 2) out.push(pt);
            }
        }
    } else if (geom.type === 'MultiPolygon') {
        for (var mi = 0; mi < geom.coordinates.length; mi++) {
            var poly = geom.coordinates[mi] || [];
            for (var rj = 0; rj < poly.length; rj++) {
                var mRing = poly[rj] || [];
                for (var pj = 0; pj < mRing.length; pj++) {
                    var mPt = mRing[pj];
                    if (Array.isArray(mPt) && mPt.length >= 2) out.push(mPt);
                }
            }
        }
    }
    return out;
}

function _get_track_extents(feature, motion) {
    if (!feature?.geometry || !motion || motion.stormLat == null || motion.stormLon == null) return null;
    var vertices = _collect_geometry_points(feature);
    if (!vertices.length) return null;
    var minAlong = Infinity;
    var maxAlong = -Infinity;
    var maxCross = 0;
    var origin = turf.point([motion.stormLon, motion.stormLat]);
    for (var i = 0; i < vertices.length; i++) {
        try {
            var pt = turf.point(vertices[i]);
            var distMiles = turf.distance(origin, pt, { units: 'miles' });
            var bearing = turf.bearing(origin, pt);
            var deltaDeg = ((bearing - motion.bearingDeg + 540) % 360) - 180;
            var deltaRad = deltaDeg * Math.PI / 180;
            var along = distMiles * Math.cos(deltaRad);
            var cross = Math.abs(distMiles * Math.sin(deltaRad));
            if (along < minAlong) minAlong = along;
            if (along > maxAlong) maxAlong = along;
            if (cross > maxCross) maxCross = cross;
        } catch (_) {}
    }
    if (!Number.isFinite(minAlong) || !Number.isFinite(maxAlong)) return null;
    return { minAlongMiles: minAlong, maxAlongMiles: maxAlong, maxCrossMiles: maxCross };
}

function _is_city_in_path_corridor(motion, city, halfWidthMiles, maxEtaMin) {
    var metrics = _city_path_metrics(motion, city);
    if (!metrics || !motion?.speedMph || motion.speedMph <= 0) return null;
    if (metrics.alongMiles <= 0) return null;
    var eta = _city_eta_minutes(metrics.alongMiles, motion.speedMph);
    if (!eta || eta <= 0) return null;
    var maxEta = maxEtaMin || 120;
    if (eta > maxEta) return null;
    var halfWidth = Number.isFinite(halfWidthMiles) ? halfWidthMiles : 12;
    if (metrics.crossMiles > halfWidth) return null;
    return {
        etaMin: eta,
        alongMiles: metrics.alongMiles,
        crossMiles: metrics.crossMiles,
        distMiles: metrics.distMiles
    };
}

function _find_city_in_storm_path(feature, motion, callback) {
    if (!motion || motion.stormLat == null || motion.stormLon == null) return callback(null);
    var extents = _get_track_extents(feature, motion);
    var halfWidthMiles = Math.min(22, Math.max(5, (extents?.maxCrossMiles || 10) * 0.8));
    var leadMinutes = [20, 35, 50, 70];
    var idx = 0;

    function finish(city) {
        if (!city) return callback(null);
        var corridorCheck = _is_city_in_path_corridor(motion, city, halfWidthMiles, 120);
        if (!corridorCheck) return callback(null);
        city.etaMin = corridorCheck.etaMin;
        city.alongMiles = corridorCheck.alongMiles;
        city.crossMiles = corridorCheck.crossMiles;
        callback(city);
    }

    function queryNext() {
        if (idx >= leadMinutes.length) {
            _find_major_city_in_polygon(feature, function (fallbackCity) {
                if (!fallbackCity) return callback(null);
                finish(fallbackCity);
            });
            return;
        }

        var mins = leadMinutes[idx++];
        var distanceMiles = Math.max(8, motion.speedMph * (mins / 60));
        var target = turf.destination(
            turf.point([motion.stormLon, motion.stormLat]),
            distanceMiles,
            motion.bearingDeg,
            { units: 'miles' }
        );
        var coords = target.geometry.coordinates;
        var url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/' +
            coords[0].toFixed(4) + ',' + coords[1].toFixed(4) +
            '.json?types=place&limit=5&country=us&access_token=' + MAPBOX_TOKEN;

        fetch(url)
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                var places = (data && Array.isArray(data.features)) ? data.features : [];
                for (var i = 0; i < places.length; i++) {
                    var place = places[i];
                    var candidate = {
                        name: place.text || place.place_name,
                        lng: place.center?.[0],
                        lat: place.center?.[1]
                    };
                    if (!candidate.name || candidate.lng == null || candidate.lat == null) continue;
                    var fitsPath = _is_city_in_path_corridor(motion, candidate, halfWidthMiles, 120);
                    if (fitsPath) {
                        candidate.etaMin = fitsPath.etaMin;
                        candidate.alongMiles = fitsPath.alongMiles;
                        candidate.crossMiles = fitsPath.crossMiles;
                        return callback(candidate);
                    }
                }
                queryNext();
            })
            .catch(function () { queryNext(); });
    }

    queryNext();
}

function _city_distance_miles(motion, city) {
    var metrics = _city_path_metrics(motion, city);
    if (!metrics) return null;
    return metrics.alongMiles > 0 ? metrics.alongMiles : metrics.distMiles;
}

function _city_eta_minutes(distMiles, speedMph) {
    if (!distMiles || !speedMph || speedMph <= 0) return null;
    return Math.round((distMiles / speedMph) * 60);
}

// ── Storm Track Layer ────────────────────────────────────────────────────────

function _add_storm_track(motion, feature) {
    _remove_storm_track();
    if (!motion || motion.stormLat == null || motion.stormLon == null) return;

    var origin = [motion.stormLon, motion.stormLat];
    var extents = _get_track_extents(feature, motion);
    var startAlong = extents ? Math.min(extents.minAlongMiles, 0) : 0;
    var frontAlong = extents ? Math.max(extents.maxAlongMiles, 0) : 0;
    var leadMiles = Math.min(70, Math.max(20, motion.speedMph * 0.75));
    var endAlong = frontAlong + leadMiles;

    function _point_at_along_miles(alongMiles) {
        var bearing = motion.bearingDeg;
        var distance = alongMiles;
        if (alongMiles < 0) {
            bearing = (bearing + 180) % 360;
            distance = Math.abs(alongMiles);
        }
        return turf.destination(turf.point(origin), distance, bearing, { units: 'miles' }).geometry.coordinates;
    }

    var startPt = _point_at_along_miles(startAlong);
    var endCoords = _point_at_along_miles(endAlong);

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

function _get_cig_level(props) {
    var label = String((props && props.label) || '');
    var label2 = String((props && props.label2) || '');
    var fromLabel = label.match(/CIG\s*([1-3])/i);
    if (fromLabel) return Number(fromLabel[1]);
    var fromLabel2 = label2.match(/INTENSITY\s*(?:LEVEL|GROUP)\s*([1-3])/i);
    if (fromLabel2) return Number(fromLabel2[1]);
    return 1;
}

function _cig_hazard_name(props, hazard) {
    var label2 = String((props && props.label2) || '');
    var m = label2.match(/^\s*([A-Za-z]+)\s+Conditional\s+Intensity\s+Group/i);
    if (m && m[1]) return m[1];
    if (hazard === 'hail') return 'Hail';
    if (hazard === 'tornado') return 'Tornado';
    if (hazard === 'wind') return 'Wind';
    return 'Severe';
}

function _format_cig_label(props, hazard) {
    var level = _get_cig_level(props);
    var name = _cig_hazard_name(props, hazard);
    var nameUpper = String(name).toUpperCase();
    var suffix = '';
    if (nameUpper === 'HAIL') {
        if (level === 1) suffix = ' >2"';
        else if (level === 2) suffix = ' >3.5"';
    } else if (nameUpper === 'WIND') {
        if (level === 1) suffix = ' 75mph+';
        else if (level === 2) suffix = ' 85mph+';
        else if (level === 3) suffix = ' 95mph+';
    } else if (nameUpper === 'TORNADO') {
        if (level === 1) suffix = ' EF2+';
        else if (level === 2) suffix = ' EF3+';
        else if (level === 3) suffix = ' EF4+';
    }
    return 'CIG' + level + suffix;
}

function _simplify_spc_legend_label(label, hazard, isCig) {
    var raw = String(label || '').trim();
    if (!raw) return 'Risk';
    if (hazard === 'tornado' && !isCig) {
        var pct = raw.match(/(\d+\s*%)/);
        if (pct && pct[1]) return pct[1].replace(/\s+/g, '') + ' Tornado Risk';
        return raw;
    }
    return raw;
}

function _spc_legend_rank(item) {
    if (!item) return -1;
    if (item.isCig) return 5000 + (item.cigLevel || 0);

    var label = String(item.rawLabel || item.label || '');
    var pct = label.match(/(\d+)\s*%/);
    if (pct && pct[1]) return 1000 + Number(pct[1]);

    var risk = _classify_risk({ label: label, label2: label });
    var riskOrder = ['TSTM', 'MRGL', 'SLGT', 'ENH', 'MDT', 'HIGH'];
    var riskIdx = riskOrder.indexOf(risk);
    if (riskIdx >= 0) return 100 + (riskIdx * 10);

    return 0;
}

function _spc_draw_polygon_ring(ctx, ringCoords) {
    if (!ringCoords || !ringCoords.length) return;
    for (var i = 0; i < ringCoords.length; i++) {
        var c = ringCoords[i];
        if (!Array.isArray(c) || c.length < 2) continue;
        var p = map.project([c[0], c[1]]);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
}

function _spc_draw_feature_path(ctx, feature) {
    var geom = feature && feature.geometry;
    if (!geom || !geom.type) return false;
    ctx.beginPath();
    if (geom.type === 'Polygon') {
        var rings = geom.coordinates || [];
        for (var i = 0; i < rings.length; i++) _spc_draw_polygon_ring(ctx, rings[i]);
        return true;
    }
    if (geom.type === 'MultiPolygon') {
        var polys = geom.coordinates || [];
        for (var pi = 0; pi < polys.length; pi++) {
            var mRings = polys[pi] || [];
            for (var ri = 0; ri < mRings.length; ri++) _spc_draw_polygon_ring(ctx, mRings[ri]);
        }
        return true;
    }
    return false;
}

function _spc_mercator_from_lnglat(lng, lat) {
    var x = (lng + 180) / 360;
    var clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
    var rad = clampedLat * Math.PI / 180;
    var y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
    return { x: x, y: y };
}

function _spc_lnglat_from_mercator(x, y) {
    var lng = (x * 360) - 180;
    var n = Math.PI - (2 * Math.PI * y);
    var lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return [lng, lat];
}

function _spc_feature_world_bbox(feature) {
    if (!feature || !feature.geometry) return null;
    var geom = feature.geometry;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    function visitPoint(coord) {
        if (!Array.isArray(coord) || coord.length < 2) return;
        var m = _spc_mercator_from_lnglat(coord[0], coord[1]);
        if (m.x < minX) minX = m.x;
        if (m.y < minY) minY = m.y;
        if (m.x > maxX) maxX = m.x;
        if (m.y > maxY) maxY = m.y;
    }
    if (geom.type === 'Polygon') {
        var rings = geom.coordinates || [];
        for (var r = 0; r < rings.length; r++) {
            var ring = rings[r] || [];
            for (var i = 0; i < ring.length; i++) visitPoint(ring[i]);
        }
    } else if (geom.type === 'MultiPolygon') {
        var polys = geom.coordinates || [];
        for (var p = 0; p < polys.length; p++) {
            var pRings = polys[p] || [];
            for (var r2 = 0; r2 < pRings.length; r2++) {
                var ring2 = pRings[r2] || [];
                for (var i2 = 0; i2 < ring2.length; i2++) visitPoint(ring2[i2]);
            }
        }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
}

function _spc_collect_segment_points(box, family, c) {
    var pts = [];
    var eps = 1e-9;
    var minX = box.minX, maxX = box.maxX, minY = box.minY, maxY = box.maxY;
    function pushIfInside(x, y) {
        if (x < minX - eps || x > maxX + eps || y < minY - eps || y > maxY + eps) return;
        for (var i = 0; i < pts.length; i++) {
            if (Math.abs(pts[i].x - x) < 1e-7 && Math.abs(pts[i].y - y) < 1e-7) return;
        }
        pts.push({ x: x, y: y });
    }
    if (family === 'diag-pos') {
        pushIfInside(minX, c - minX);
        pushIfInside(maxX, c - maxX);
        pushIfInside(c - minY, minY);
        pushIfInside(c - maxY, maxY);
    } else {
        pushIfInside(minX, minX - c);
        pushIfInside(maxX, maxX - c);
        pushIfInside(c + minY, minY);
        pushIfInside(c + maxY, maxY);
    }
    if (pts.length < 2) return null;
    var a = pts[0], b = pts[1], bestDist = -1;
    for (var i = 0; i < pts.length; i++) {
        for (var j = i + 1; j < pts.length; j++) {
            var dx = pts[j].x - pts[i].x;
            var dy = pts[j].y - pts[i].y;
            var d = (dx * dx) + (dy * dy);
            if (d > bestDist) { bestDist = d; a = pts[i]; b = pts[j]; }
        }
    }
    return [a, b];
}

function _spc_draw_cig_hatching(ctx, feature, strokeColor, cigLevel) {
    if (!ctx || !_spcOverlayCanvas) return;
    var width = _spcOverlayCanvas.clientWidth || _spcOverlayCanvas.width || 0;
    var height = _spcOverlayCanvas.clientHeight || _spcOverlayCanvas.height || 0;
    if (width <= 0 || height <= 0) return;

    ctx.save();
    if (!_spc_draw_feature_path(ctx, feature)) { ctx.restore(); return; }
    ctx.clip('evenodd');

    var level = Number(cigLevel) || 1;
    var bbox = _spc_feature_world_bbox(feature);
    if (!bbox) { ctx.restore(); return; }

    var zoom = (typeof map.getZoom === 'function') ? map.getZoom() : 4.3;
    var zoomScale = Math.pow(2, zoom - 4.3);
    var worldPxAtBaseZoom = 512 * Math.pow(2, 4.3);

    function _stroke_hatch(family, baseSpacingPx, dashPatternPx) {
        var spacingWorld = (baseSpacingPx / worldPxAtBaseZoom) * Math.sqrt(2);
        var cMin = family === 'diag-pos' ? (bbox.minX + bbox.minY) : (bbox.minX - bbox.maxY);
        var cMax = family === 'diag-pos' ? (bbox.maxX + bbox.maxY) : (bbox.maxX - bbox.minY);
        var start = Math.floor(cMin / spacingWorld) * spacingWorld;
        var scaledDash = (dashPatternPx || []).map(function (n) { return Math.max(2, Math.min(160, n * zoomScale)); });
        ctx.beginPath();
        ctx.setLineDash(scaledDash);
        for (var cc = start; cc <= cMax + spacingWorld; cc += spacingWorld) {
            var seg = _spc_collect_segment_points(bbox, family, cc);
            if (!seg) continue;
            var aLngLat = _spc_lnglat_from_mercator(seg[0].x, seg[0].y);
            var bLngLat = _spc_lnglat_from_mercator(seg[1].x, seg[1].y);
            var a = map.project(aLngLat);
            var b = map.project(bLngLat);
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
        }
        ctx.stroke();
    }

    ctx.strokeStyle = strokeColor || '#000000';
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1.2;
    if (level === 1) {
        _stroke_hatch('diag-neg', 16, [8, 8]);
    } else if (level === 2) {
        _stroke_hatch('diag-pos', 13, []);
    } else {
        _stroke_hatch('diag-neg', 13, []);
        _stroke_hatch('diag-pos', 13, []);
    }

    ctx.restore();
}

function _render_spc_canvas() {
    if (!_spcOverlayCtx || !_spcOverlayCanvas) return;
    _spcOverlayCtx.clearRect(0, 0, _spcOverlayCanvas.width, _spcOverlayCanvas.height);

    for (var i = 0; i < _spcRegularFeatures.length; i++) {
        var feature = _spcRegularFeatures[i];
        var props = feature.properties || {};
        if (!_spc_draw_feature_path(_spcOverlayCtx, feature)) continue;
        _spcOverlayCtx.fillStyle = props.fill || '#8dc6ff';
        _spcOverlayCtx.globalAlpha = 0.75;
        _spcOverlayCtx.fill('evenodd');
    }

    _spcOverlayCtx.globalAlpha = 1;
    _spcOverlayCtx.setLineDash([]);
    _spcOverlayCtx.lineWidth = 2.4;
    for (var c = 0; c < _spcCigFeatures.length; c++) {
        var cigFeat = _spcCigFeatures[c];
        var cigProps = cigFeat.properties || {};
        _spc_draw_cig_hatching(_spcOverlayCtx, cigFeat, cigProps.stroke || '#000000', cigProps.spcCigLevel);
        if (!_spc_draw_feature_path(_spcOverlayCtx, cigFeat)) continue;
        _spcOverlayCtx.strokeStyle = cigProps.stroke || '#000000';
        _spcOverlayCtx.globalAlpha = 1;
        _spcOverlayCtx.stroke();
    }

    _spcOverlayCtx.globalAlpha = 1;
    _spcOverlayCtx.setLineDash([5, 4]);
    _spcOverlayCtx.lineWidth = 2.2;
    for (var j = 0; j < _spcHatchedFeatures.length; j++) {
        var hFeat = _spcHatchedFeatures[j];
        var hProps = hFeat.properties || {};
        if (!_spc_draw_feature_path(_spcOverlayCtx, hFeat)) continue;
        _spcOverlayCtx.strokeStyle = hProps.stroke || '#59a9ff';
        _spcOverlayCtx.stroke();
    }
    _spcOverlayCtx.setLineDash([]);
}

function _setup_spc_canvas() {
    var mapCanvas = map.getCanvas();
    var dpr = window.devicePixelRatio || 1;
    var width = mapCanvas.clientWidth;
    var height = mapCanvas.clientHeight;

    _spcOverlayCanvas = document.createElement('canvas');
    _spcOverlayCanvas.style.position = 'absolute';
    _spcOverlayCanvas.style.top = '0';
    _spcOverlayCanvas.style.left = '0';
    _spcOverlayCanvas.style.pointerEvents = 'none';
    _spcOverlayCanvas.style.zIndex = '2';
    _spcOverlayCanvas.width = Math.max(1, Math.round(width * dpr));
    _spcOverlayCanvas.height = Math.max(1, Math.round(height * dpr));
    _spcOverlayCanvas.style.width = width + 'px';
    _spcOverlayCanvas.style.height = height + 'px';
    _spcOverlayCtx = _spcOverlayCanvas.getContext('2d');
    _spcOverlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    mapCanvas.parentNode.appendChild(_spcOverlayCanvas);

    _spcRenderListener = function () { _render_spc_canvas(); };
    map.on('render', _spcRenderListener);
}

function _teardown_spc_canvas() {
    if (_spcRenderListener) {
        map.off('render', _spcRenderListener);
        _spcRenderListener = null;
    }
    if (_spcOverlayCanvas && _spcOverlayCanvas.parentNode) {
        _spcOverlayCanvas.parentNode.removeChild(_spcOverlayCanvas);
    }
    _spcOverlayCanvas = null;
    _spcOverlayCtx = null;
    _spcRegularFeatures = [];
    _spcHatchedFeatures = [];
    _spcCigFeatures = [];
}

function _add_spc_layers(geojson) {
    _remove_spc_layers();

    var allFeatures = (geojson.features || []).filter(function (f) { return f.geometry; });
    var normalizedFeatures = allFeatures.map(function (f) {
        var props = Object.assign({}, f.properties || {});
        props.spcIsHatched = _is_hatched_feature(props) ? 1 : 0;
        props.spcIsCig = _is_cig_feature(props) ? 1 : 0;
        props.spcCigLevel = props.spcIsCig ? _get_cig_level(props) : 0;
        return { type: 'Feature', geometry: f.geometry, properties: props };
    });

    _spcCigFeatures = normalizedFeatures.filter(function (f) { return f.properties.spcIsCig === 1; });
    _spcRegularFeatures = normalizedFeatures.filter(function (f) { return f.properties.spcIsCig !== 1 && f.properties.spcIsHatched !== 1; });
    _spcHatchedFeatures = normalizedFeatures.filter(function (f) { return f.properties.spcIsCig !== 1 && f.properties.spcIsHatched === 1; });

    if (!_spcOverlayCanvas) _setup_spc_canvas();
    _render_spc_canvas();
}

function _remove_spc_layers() {
    _teardown_spc_canvas();
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
var STORM_REPORT_LAYER_IDS = ['stormReportsLayer', 'stormReportsHaloLayer'];
var LIGHTNING_GLOW_LAYER_ID = 'lightningGlow';
var LIGHTNING_CORE_LAYER_ID = 'lightningCore';

function _segment_allows_site_radar() {
    return !_active || _currentSegmentType === 'alert' || _currentSegmentType === 'spotlight';
}

function _clear_active_station_selection() {
    try {
        if (window.stormTrackData) {
            window.stormTrackData.currentStation = null;
            window.stormTrackData.L2_file_id = '';
        }
    } catch (_) {}
    try { $('#radarStation').html(''); } catch (_) {}
    try { $('#radarLocation').html(''); } catch (_) {}
    try { $('#radarVCP').html(''); } catch (_) {}
    try { $('#radarInfoSpan').hide(); } catch (_) {}
}

function _enforce_non_site_station_state() {
    if (!_active || _segment_allows_site_radar()) return;
    _clear_active_station_selection();
    _hide_radar_render();
    _hide_station_markers();
    _hide_radar_sweep();
    _hide_lightning_overlay();
}

function _start_non_site_guard() {
    if (_nonSiteGuardTimer != null) return;
    _nonSiteGuardTimer = setInterval(function () {
        if (!_active) {
            _stop_non_site_guard();
            return;
        }
        _enforce_non_site_station_state();
    }, 250);
}

function _stop_non_site_guard() {
    if (_nonSiteGuardTimer != null) {
        clearInterval(_nonSiteGuardTimer);
        _nonSiteGuardTimer = null;
    }
}

function _hide_radar_render() {
    try {
        if (map.getLayer('baseReflectivity')) map.setLayoutProperty('baseReflectivity', 'visibility', 'none');
        if (map.getLayer('station_range_layer')) map.setLayoutProperty('station_range_layer', 'visibility', 'none');
    } catch (_) {}
}

function _show_radar_render() {
    if (!_segment_allows_site_radar()) {
        _hide_radar_render();
        return;
    }
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
    if (!_segment_allows_site_radar()) {
        _hide_station_markers();
        return;
    }
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

function _is_scan_rendered_for_station(station) {
    if (!station) return false;
    try {
        if (!map.getLayer('baseReflectivity')) return false;
        if (map.getLayoutProperty('baseReflectivity', 'visibility') === 'none') return false;
    } catch (_) {
        return false;
    }
    var factoryStation = window.stormTrackData?.nexrad_factory?.station;
    if (!factoryStation || factoryStation !== station) return false;
    return true;
}

function _show_radar_sweep() {
    if (!_segment_allows_site_radar()) {
        _hide_radar_sweep();
        return;
    }
    try {
        var s = settings_store.load();
        var station = window.stormTrackData?.currentStation;
        if (!station || !_is_scan_rendered_for_station(station)) {
            _hide_radar_sweep();
            return;
        }
        var forceLiveModeSweep = !!(_active && station);
        if (forceLiveModeSweep || s.radarSweep !== false) {
            radar_scan_animation.update(station);
        } else {
            _hide_radar_sweep();
        }
    } catch (_) {}
}

function _bind_sweep_sync_listeners() {
    if (_sweepBaseSelectionListener || _sweepBaseLoadedListener) return;

    _sweepBaseSelectionListener = function (e) {
        if (!_active) return;
        if (!_segment_allows_site_radar()) {
            _enforce_non_site_station_state();
            return;
        }
        var detail = e?.detail || {};
        var station = window.stormTrackData?.currentStation;
        if (!station) {
            _hide_radar_sweep();
            return;
        }
        // Hide sweep immediately while the new base scan is loading.
        if (!detail.station || detail.station === station) {
            _hide_radar_sweep();
        }
    };

    _sweepBaseLoadedListener = function (e) {
        if (!_active) return;
        if (!_segment_allows_site_radar()) {
            _enforce_non_site_station_state();
            return;
        }
        var detail = e?.detail || {};
        var station = window.stormTrackData?.currentStation;
        if (!station) {
            _hide_radar_sweep();
            return;
        }
        if (detail.station && detail.station !== station) return;
        _show_radar_sweep();
    };

    window.addEventListener('radarBaseSelectionRequested', _sweepBaseSelectionListener);
    window.addEventListener('radarBaseFactoryLoaded', _sweepBaseLoadedListener);
}

function _unbind_sweep_sync_listeners() {
    if (_sweepBaseSelectionListener) {
        window.removeEventListener('radarBaseSelectionRequested', _sweepBaseSelectionListener);
        _sweepBaseSelectionListener = null;
    }
    if (_sweepBaseLoadedListener) {
        window.removeEventListener('radarBaseFactoryLoaded', _sweepBaseLoadedListener);
        _sweepBaseLoadedListener = null;
    }
}

function _hide_storm_reports() {
    try {
        for (var i = 0; i < STORM_REPORT_LAYER_IDS.length; i++) {
            if (map.getLayer(STORM_REPORT_LAYER_IDS[i])) map.setLayoutProperty(STORM_REPORT_LAYER_IDS[i], 'visibility', 'none');
        }
    } catch (_) {}
}

function _show_storm_reports() {
    try {
        for (var i = 0; i < STORM_REPORT_LAYER_IDS.length; i++) {
            if (map.getLayer(STORM_REPORT_LAYER_IDS[i])) map.setLayoutProperty(STORM_REPORT_LAYER_IDS[i], 'visibility', 'visible');
        }
    } catch (_) {}
}

function _hide_lightning_overlay() {
    try {
        for (var i = 0; i < lightning.LAYERS.length; i++) {
            if (map.getLayer(lightning.LAYERS[i])) map.setLayoutProperty(lightning.LAYERS[i], 'visibility', 'none');
        }
    } catch (_) {}
}

function _show_lightning_overlay() {
    if (!_segment_allows_site_radar()) {
        _hide_lightning_overlay();
        return;
    }
    try {
        var station = window.stormTrackData?.currentStation;
        if (!station) return;
        var s = settings_store.load();
        if (!s.lightning) return;
        for (var i = 0; i < lightning.LAYERS.length; i++) {
            if (map.getLayer(lightning.LAYERS[i])) map.setLayoutProperty(lightning.LAYERS[i], 'visibility', 'visible');
        }
        _apply_live_mode_lightning_style();
    } catch (_) {}
}

function _apply_live_mode_lightning_style() {
    if (!_active) return;
    try {
        if (map.getLayer(LIGHTNING_GLOW_LAYER_ID)) {
            map.setPaintProperty(LIGHTNING_GLOW_LAYER_ID, 'circle-opacity', ['min', 1, ['*', ['get', 'go'], 1.9]]);
            map.setPaintProperty(LIGHTNING_GLOW_LAYER_ID, 'circle-radius', ['*', ['get', 'gr'], 1.3]);
            map.setPaintProperty(LIGHTNING_GLOW_LAYER_ID, 'circle-color', '#e8eeff');
        }
        if (map.getLayer(LIGHTNING_CORE_LAYER_ID)) {
            map.setPaintProperty(LIGHTNING_CORE_LAYER_ID, 'circle-opacity', ['min', 1, ['*', ['get', 'co'], 1.85]]);
            map.setPaintProperty(LIGHTNING_CORE_LAYER_ID, 'circle-radius', ['*', ['get', 'cr'], 1.22]);
            map.setPaintProperty(LIGHTNING_CORE_LAYER_ID, 'circle-color', '#ffffff');
        }
    } catch (_) {}
}

function _restore_live_mode_lightning_style() {
    try {
        if (map.getLayer(LIGHTNING_GLOW_LAYER_ID)) {
            map.setPaintProperty(LIGHTNING_GLOW_LAYER_ID, 'circle-radius', ['get', 'gr']);
            map.setPaintProperty(LIGHTNING_GLOW_LAYER_ID, 'circle-color', '#dde4ff');
            map.setPaintProperty(LIGHTNING_GLOW_LAYER_ID, 'circle-opacity', ['get', 'go']);
        }
        if (map.getLayer(LIGHTNING_CORE_LAYER_ID)) {
            map.setPaintProperty(LIGHTNING_CORE_LAYER_ID, 'circle-radius', ['get', 'cr']);
            map.setPaintProperty(LIGHTNING_CORE_LAYER_ID, 'circle-color', '#ffffff');
            map.setPaintProperty(LIGHTNING_CORE_LAYER_ID, 'circle-opacity', ['get', 'co']);
        }
    } catch (_) {}
}

function _hide_all_map_overlays() {
    _hide_radar_render();
    _hide_station_markers();
    _hide_alert_polygons();
    _hide_radar_sweep();
    _hide_lightning_overlay();
}

function _show_all_map_overlays() {
    _show_radar_render();
    _show_station_markers();
    _show_alert_polygons();
    _show_radar_sweep();
    _show_lightning_overlay();
}

function _run_spc_segment(resolve) {
    var hazard = _pick_random(SPC_HAZARDS.filter(function (h) { return !_was_recent('spc', h); }));
    if (!hazard) hazard = _pick_random(SPC_HAZARDS);
    _record_segment('spc', hazard);
    _currentSegmentType = 'spc';
    _set_segment_stage('enter');

    _set_clock_mode('hidden');
    _hide_all_map_overlays();
    _remove_focus_glow();
    _remove_storm_track();
    _remove_static_mrms_layer();
    _remove_conditions_layer();
    _remove_earthquake_layer();
    _hide_storm_reports();
    _clear_active_station_selection();
    _hide_header_radar_info(null, { allowSocialFallback: false });
    _show_info_panel(_build_spc_panel_html(_spc_label(hazard)));

    var catPromise = (hazard !== 'categorical')
        ? _fetch_spc_geojson('categorical')
        : Promise.resolve(null);

    _set_segment_stage('fetch');
    Promise.all([_fetch_spc_geojson(hazard), catPromise]).then(function (results) {
        var geojson = results[0];
        var catGeojson = results[1];
        if (!_active) { _show_header_radar_info(); _hide_spc_legend(); return resolve(); }

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
        _set_segment_stage('render');
        _show_spc_legend(geojson, hazard);
        var validity = _get_spc_validity(geojson);
        _show_info_panel(_build_spc_panel_html(_spc_label(hazard), validity));
        var riskHtml = _build_risk_label(geojson) || _build_risk_label(catGeojson);
        _hide_header_radar_info(riskHtml, { allowSocialFallback: false });
        if (Math.random() > 0.35) {
            _typewrite(_generate_spc_commentary(hazard, geojson), 1200);
        }

        function _spc_cleanup() {
            _set_segment_stage('finish');
            _stop_typewriter();
            _remove_spc_layers();
            _hide_spc_legend();
            _show_header_radar_info();
            _hide_info_panel();
            resolve();
        }

        var riskOrder = ['TSTM', 'MRGL', 'SLGT', 'ENH', 'MDT', 'HIGH'];
        var highestLevel = -1;
        for (var fi = 0; fi < features.length; fi++) {
            var risk = _classify_risk(features[fi].properties || {});
            var lvl = risk ? riskOrder.indexOf(risk) : -1;
            if (lvl > highestLevel) highestLevel = lvl;
        }

        var panTargets = [];
        if (highestLevel >= 1) {
            var highestRisk = riskOrder[highestLevel];
            for (var fj = 0; fj < features.length; fj++) {
                var fRisk = _classify_risk(features[fj].properties || {});
                if (fRisk !== highestRisk) continue;
                var geom = features[fj].geometry;
                if (!geom) continue;
                try {
                    if (geom.type === 'MultiPolygon') {
                        for (var mp = 0; mp < geom.coordinates.length; mp++) {
                            var subPoly = { type: 'Feature', geometry: { type: 'Polygon', coordinates: geom.coordinates[mp] }, properties: {} };
                            var subBbox = turf.bbox(subPoly);
                            var subCenter = turf.centroid(subPoly).geometry.coordinates;
                            if (isFinite(subBbox[0])) panTargets.push({ center: subCenter, bbox: subBbox });
                        }
                    } else {
                        var fBbox = turf.bbox(features[fj]);
                        var fCenter = turf.centroid(features[fj]).geometry.coordinates;
                        if (isFinite(fBbox[0])) panTargets.push({ center: fCenter, bbox: fBbox });
                    }
                } catch (_) {}
            }
        }

        var OVERVIEW_MS = panTargets.length > 0 ? Math.floor(SPC_SEGMENT_DURATION_MS * 0.5) : SPC_SEGMENT_DURATION_MS;
        var PAN_TOTAL_MS = SPC_SEGMENT_DURATION_MS - OVERVIEW_MS;

        if (panTargets.length === 0) {
            _segmentTimer = setTimeout(function () {
                _set_segment_stage('wait-text');
                _wait_for_typewriter_then(function () { _spc_cleanup(); });
            }, SPC_SEGMENT_DURATION_MS);
        } else {
            var DWELL_PER = Math.floor(PAN_TOTAL_MS / panTargets.length);
            var panIdx = 0;

            function _pan_next_spc() {
                if (!_active || panIdx >= panTargets.length) {
                    _segmentTimer = setTimeout(function () {
                        _set_segment_stage('wait-text');
                        _wait_for_typewriter_then(function () { _spc_cleanup(); });
                    }, Math.min(DWELL_PER, 4000));
                    return;
                }
                _set_segment_stage('pan');
                var t = panTargets[panIdx];
                map.fitBounds([[t.bbox[0], t.bbox[1]], [t.bbox[2], t.bbox[3]]], {
                    padding: 80, maxZoom: 9, speed: 0.8, essential: true
                });
                panIdx++;
                _segmentTimer = setTimeout(_pan_next_spc, DWELL_PER);
            }

            _segmentTimer = setTimeout(function () {
                if (!_active) return _spc_cleanup();
                _pan_next_spc();
            }, OVERVIEW_MS);
        }
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

function _parse_alert_params(feature) {
    var raw = feature?.properties?.parameters;
    if (!raw) return {};
    if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch (_) { return {}; }
    }
    return raw;
}

function _get_alert_visit_key(feature) {
    return feature?.id || feature?.properties?.id || null;
}

function _get_alert_update_ms(feature) {
    var p = feature?.properties || {};
    var candidates = [p.sent, p.effective, p.onset, p.expires, p.ends];
    for (var i = 0; i < candidates.length; i++) {
        if (!candidates[i]) continue;
        var ts = new Date(candidates[i]).getTime();
        if (Number.isFinite(ts)) return ts;
    }
    return null;
}

function _get_alert_expires_ms(feature) {
    var p = feature?.properties || {};
    var expiresMs = new Date(p.expires || p.ends || '').getTime();
    return Number.isFinite(expiresMs) ? expiresMs : null;
}

function _build_alert_fingerprint(feature) {
    var p = feature?.properties || {};
    var params = _parse_alert_params(feature);
    var torDet = _fn_arr(params.tornadoDetection) || '';
    var wind = _fn_arr(params.maxWindGust) || '';
    var hail = _fn_arr(params.maxHailSize) || '';
    var floodThreat = _fn_arr(params.flashFloodDamageThreat) || '';
    var desc = (p.description || '').slice(0, 900);
    return [
        p.event || '',
        p.sent || '',
        p.effective || '',
        p.expires || '',
        p.messageType || '',
        torDet,
        wind,
        hail,
        floodThreat,
        desc
    ].join('|');
}

function _is_observed_tornado_warning(feature, params, descUpper) {
    var event = feature?.properties?.event || '';
    if (event !== 'Tornado Warning') return false;
    var torSrc = _fn_arr(params.tornadoDetection) || '';
    return torSrc.toLowerCase().includes('observed') || descUpper.includes('CONFIRMED');
}

function _is_radar_indicated_tornado_warning(feature, params, descUpper) {
    var event = feature?.properties?.event || '';
    if (event !== 'Tornado Warning') return false;
    var torSrc = _fn_arr(params.tornadoDetection) || '';
    return torSrc.toLowerCase().includes('radar indicated') || descUpper.includes('RADAR INDICATED');
}

function _is_expiring_or_weakening_tornado_warning(event, descUpper) {
    if (event !== 'Tornado Warning') return false;
    if (!descUpper) return false;
    var phrases = [
        'WILL BE ALLOWED TO EXPIRE',
        'WARNING WILL BE ALLOWED TO EXPIRE',
        'HAS WEAKENED BELOW SEVERE LIMITS',
        'NO LONGER APPEARS CAPABLE OF PRODUCING A TORNADO',
        'THE TORNADO WARNING FOR',
        'THIS TORNADO WARNING FOR'
    ];
    for (var i = 0; i < phrases.length; i++) {
        if (descUpper.includes(phrases[i])) return true;
    }
    return false;
}

function _get_alert_focus_class(feature, context) {
    var event = context?.event || feature?.properties?.event || '';
    if ((context && context.isTornadoEvent) || TORNADO_EVENTS.includes(event) || event === 'Tornado Warning') {
        return 'tornado';
    }
    if (event === 'Severe Thunderstorm Warning') return 'severe-thunderstorm';
    if (event === 'Flash Flood Warning') return 'flash-flood';
    if (event === 'Evacuation - Immediate') return 'evacuation';
    if (event === 'Special Weather Statement') return 'special-weather';
    return 'other-severe';
}

function _get_alert_focus_context(feature) {
    var key = _get_alert_visit_key(feature);
    var p = feature?.properties || {};
    var params = _parse_alert_params(feature);
    var descUpper = (p.description || '').toUpperCase();
    var event = p.event || '';
    var isTornadoEvent = TORNADO_EVENTS.includes(event) || event === 'Tornado Warning';
    var isObservedTornado = _is_observed_tornado_warning(feature, params, descUpper);
    var isRadarIndicatedTornado = _is_radar_indicated_tornado_warning(feature, params, descUpper);
    var isExpiringOrWeakeningTornado = _is_expiring_or_weakening_tornado_warning(event, descUpper);
    var history = key ? _alertVisitHistory[key] : null;
    var fingerprint = _build_alert_fingerprint(feature);
    var hasChangedSinceLastVisit = !!(history && history.fingerprint && history.fingerprint !== fingerprint);
    return {
        key: key,
        event: event,
        params: params,
        descUpper: descUpper,
        history: history || null,
        visitCount: history ? (history.count || 0) : 0,
        isRevisit: !!history,
        isTornadoEvent: isTornadoEvent,
        isObservedTornado: isObservedTornado,
        isRadarIndicatedTornado: isRadarIndicatedTornado,
        isExpiringOrWeakeningTornado: isExpiringOrWeakeningTornado,
        alertClass: _get_alert_focus_class(feature, { event: event, isTornadoEvent: isTornadoEvent }),
        hasChangedSinceLastVisit: hasChangedSinceLastVisit,
        lastUpdateMs: _get_alert_update_ms(feature),
        expiresMs: _get_alert_expires_ms(feature),
        fingerprint: fingerprint
    };
}

function _is_tornado_focus_blocked(context, nowMs) {
    if (!context?.isTornadoEvent) return false;
    if (context.isExpiringOrWeakeningTornado) return true;

    var expiresMs = context.expiresMs;
    if (!Number.isFinite(expiresMs)) return false;
    if (expiresMs <= nowMs) return true;

    var expireSoonThresholdMs = nowMs + (ALERT_TORNADO_EXPIRE_SOON_MIN * 60000);
    return expiresMs <= expireSoonThresholdMs;
}

function _score_alert_for_focus(feature, context, nowMs) {
    var event = context.event;
    var score = 20;

    if (event === 'Tornado Emergency' || event === 'PDS Tornado Warning') score += 140;
    else if (context.isObservedTornado) score += 115;
    else if (event === 'Tornado Warning') score += 90;
    else if (event === 'Severe Thunderstorm Warning') score += (_is_tornado_eligible(feature) ? 55 : 38);
    else if (event === 'Flash Flood Warning') score += 35;
    else if (event === 'Special Weather Statement') score += 30;
    else score += 22;

    if (context.lastUpdateMs) {
        var ageMin = Math.max(0, (nowMs - context.lastUpdateMs) / 60000);
        score += Math.max(0, 28 - ageMin * 0.45);
    }

    if (!context.history) {
        score += 24;
    } else {
        var minsSinceVisit = Math.max(0, (nowMs - context.history.lastSeenMs) / 60000);
        if (minsSinceVisit < 1.5) score -= 85;
        else if (minsSinceVisit < 3) score -= 35;

        if (context.isTornadoEvent && minsSinceVisit >= 3) {
            score += Math.min(34, minsSinceVisit * 3.6);
        }
        if (context.isObservedTornado && minsSinceVisit >= 2) {
            score += Math.min(26, minsSinceVisit * 3.2);
        }
    }

    if (context.hasChangedSinceLastVisit) {
        score += context.isTornadoEvent ? 34 : 16;
    }

    if (context.isExpiringOrWeakeningTornado) {
        // De-prioritize warnings that are being allowed to expire/are weakening.
        score -= 80;
    }

    if (context.visitCount >= 4 && !context.isTornadoEvent) score -= 14 * (context.visitCount - 3);
    if (context.visitCount >= 5 && context.isTornadoEvent) score -= 7 * (context.visitCount - 4);

    if (!context.isTornadoEvent) {
        var classHistory = _alertFocusClassHistory[context.alertClass];
        var classBonus = 0;
        if (!classHistory || !classHistory.lastSeenMs) {
            classBonus = Math.round(ALERT_CLASS_FAIRNESS_BONUS_MAX * 0.75);
        } else {
            var minsSinceClassFocus = Math.max(0, (nowMs - classHistory.lastSeenMs) / 60000);
            classBonus = Math.min(
                ALERT_CLASS_FAIRNESS_BONUS_MAX,
                (minsSinceClassFocus / ALERT_CLASS_FAIRNESS_RAMP_MIN) * ALERT_CLASS_FAIRNESS_BONUS_MAX
            );
        }
        score += classBonus;
    }

    return Math.max(1, score);
}

function _pick_alert_focus_feature(alerts) {
    if (!alerts || !alerts.length) return { feature: null, context: null };
    var nowMs = Date.now();
    var scored = alerts.map(function (feature) {
        var context = _get_alert_focus_context(feature);
        var score = _score_alert_for_focus(feature, context, nowMs);
        return { feature: feature, context: context, score: score };
    }).filter(function (item) {
        return !_is_tornado_focus_blocked(item.context, nowMs);
    });

    if (!scored.length) return { feature: null, context: null };

    function _weighted_pick_scored(items) {
        if (!items.length) return null;
        var total = 0;
        for (var i = 0; i < items.length; i++) total += items[i].score;
        var r = Math.random() * total;
        var chosen = items[0];
        for (var p = 0; p < items.length; p++) {
            r -= items[p].score;
            if (r <= 0) {
                chosen = items[p];
                break;
            }
        }
        return chosen;
    }

    scored.sort(function (a, b) { return b.score - a.score; });
    var pool = scored.slice(0, Math.min(4, scored.length));
    var enforceNonTornadoPick = _consecutiveTornadoFocusCount >= MAX_TORNADO_FOCUS_STREAK
        && scored.some(function (item) { return !item.context?.isTornadoEvent; });

    var selectionPool = pool;
    if (enforceNonTornadoPick) {
        selectionPool = scored
            .filter(function (item) { return !item.context?.isTornadoEvent; })
            .slice(0, Math.min(4, scored.length));
    }

    return _weighted_pick_scored(selectionPool) || _weighted_pick_scored(pool) || { feature: null, context: null, score: 0 };
}

function _mark_alert_focus_visit(feature, context) {
    var nowMs = Date.now();
    var alertClass = context?.alertClass || _get_alert_focus_class(feature, context);
    if (alertClass) {
        var prevClass = _alertFocusClassHistory[alertClass] || {};
        _alertFocusClassHistory[alertClass] = {
            count: (prevClass.count || 0) + 1,
            lastSeenMs: nowMs
        };
    }

    if (context?.isTornadoEvent) _consecutiveTornadoFocusCount++;
    else _consecutiveTornadoFocusCount = 0;

    var key = context?.key || _get_alert_visit_key(feature);
    if (!key) return;
    var prev = _alertVisitHistory[key] || {};
    _alertVisitHistory[key] = {
        count: (prev.count || 0) + 1,
        lastSeenMs: nowMs,
        fingerprint: context?.fingerprint || _build_alert_fingerprint(feature)
    };
}

function _build_tornado_revisit_update(feature, context) {
    var p = feature?.properties || {};
    var infoBits = [];

    if (context?.hasChangedSinceLastVisit) {
        infoBits.push('The warning text has been updated since our last check.');
    }

    if (context?.isObservedTornado) infoBits.push('It remains an observed tornado warning.');
    else if (context?.isRadarIndicatedTornado) infoBits.push('It remains radar indicated at this time.');
    else infoBits.push('It remains an active tornado warning.');

    var updateMs = _get_alert_update_ms(feature);
    if (updateMs) {
        var updateAgeMin = Math.max(0, Math.round((Date.now() - updateMs) / 60000));
        if (updateAgeMin <= 1) infoBits.push('Latest update came in moments ago.');
        else infoBits.push('Latest update came in about ' + updateAgeMin + ' minutes ago.');
    }

    var expiresMs = new Date(p.expires || p.ends || '').getTime();
    if (Number.isFinite(expiresMs)) {
        var minsLeft = Math.round((expiresMs - Date.now()) / 60000);
        if (minsLeft > 0) {
            if (minsLeft <= 1) infoBits.push('The warning is close to expiration.');
            else infoBits.push('It is currently set to expire in about ' + minsLeft + ' minutes.');
        }
    }

    return infoBits.join(' ');
}

// ── Typewriter + Commentary ─────────────────────────────────────────────────

const _commentator = new LiveModeCommentator({
    isActive: function () { return _active; },
    schedule: function (callback, ms) { _trackAlertTimer(callback, ms); },
    pickRandom: _pick_random
});

function _stop_typewriter() {
    _commentator.stopTypewriter();
}

function _show_commentary_box() {
    _commentator.showCommentaryBox();
}

function _hide_commentary_box() {
    _commentator.hideCommentaryBox();
}

function _typewrite(text, delayMs) {
    _commentator.typewrite(text, delayMs);
}

function _wait_for_typewriter_then(callback) {
    _commentator.waitForTypewriterThen(callback);
}

function _time_of_day() {
    var h = new Date().getHours();
    if (h < 6) return 'overnight';
    if (h < 12) return 'this morning';
    if (h < 17) return 'this afternoon';
    if (h < 21) return 'this evening';
    return 'tonight';
}

function _generate_alert_commentary(feature, motion, city, context) {
    var p = feature.properties || {};
    var event = p.event || 'Alert';
    var params = _parse_alert_params(feature);
    var desc = (p.description || '').toUpperCase();
    var area = p.areaDesc || 'the warned area';
    var wind = _fn_arr(params.maxWindGust);
    var hail = _fn_arr(params.maxHailSize);
    var hailNum = parseFloat(hail);
    var tod = _time_of_day();

    var lines = [];

    if (event === 'Tornado Emergency' || event === 'PDS Tornado Warning') {
        lines.push(_pick_random([
            'We are tracking a PARTICULARLY DANGEROUS SITUATION. A confirmed, large tornado is on the ground near ' + area + '.',
            'This is an ongoing TORNADO EMERGENCY for ' + area + '. A violent, life-threatening tornado has been confirmed.',
            'An extremely dangerous tornado emergency is unfolding across ' + area + ' right now.',
            'This is as serious as it gets. A tornado emergency has been declared for ' + area + '. A large and destructive tornado is on the ground.',
            'The National Weather Service has issued a TORNADO EMERGENCY for ' + area + '. This is a life-threatening situation happening right now.',
            'A catastrophic tornado is confirmed near ' + area + ' ' + tod + '. This is a rare tornado emergency, the highest urgency warning the NWS can issue.',
            'We\'re in a TORNADO EMERGENCY for ' + area + '. This means a violent tornado has been confirmed and is producing significant damage.'
        ]));
        lines.push(_pick_random([
            'If you are in the path of this storm, take shelter immediately in the lowest interior room of a sturdy building.',
            'Get underground or to the lowest floor NOW. Cover your head and stay away from all windows.',
            'This tornado is capable of leveling homes. Seek the strongest shelter available and protect yourself immediately.',
            'This is a life-or-death situation. Get to your tornado safe room right now. Basement, storm cellar, or the most interior room on the lowest floor.',
            'Do not try to outrun this tornado. If you are in a mobile home, get out and find a more substantial structure or lie flat in a ditch.',
            'Protect yourself with heavy blankets or a mattress. Get under something sturdy and cover your head. Every second counts.'
        ]));
        if (motion) {
            lines.push(_pick_random([
                'This storm is moving ' + _bearing_to_cardinal(motion.bearingDeg) + ' at ' + motion.speedMph + ' mph.',
                'The tornado is tracking ' + _bearing_to_cardinal(motion.bearingDeg) + ' at ' + motion.speedMph + ' miles per hour.',
                'Radar shows this violent storm pushing ' + _bearing_to_cardinal(motion.bearingDeg) + ' at ' + motion.speedMph + ' mph and it\'s covering ground fast.'
            ]));
            if (city) {
                var cityDist = _city_distance_miles(motion, city);
                var etaMin = _city_eta_minutes(cityDist, motion.speedMph);
                if (etaMin && etaMin > 0 && etaMin < 120) {
                    lines.push(_pick_random([
                        'At this speed, the storm could impact ' + city.name + ' in approximately ' + etaMin + ' minutes.',
                        city.name + ' is roughly ' + Math.round(cityDist) + ' miles in the storm\'s path. Estimated impact in about ' + etaMin + ' minutes.',
                        'At this pace, ' + city.name + ' has about ' + etaMin + ' minutes before the storm arrives. Take shelter now if you\'re in that area.',
                        city.name + ' is directly downstream, approximately ' + etaMin + ' minutes out at current storm speed.',
                        'If you\'re in ' + city.name + ', you have roughly ' + etaMin + ' minutes. Do not wait. Act now.'
                    ]));
                }
            }
        }
    } else if (event === 'Tornado Warning') {
        if (context?.isRevisit) {
            var torWarnType = context.isObservedTornado ? 'observed' : (context.isRadarIndicatedTornado ? 'radar-indicated' : 'active');
            lines.push('Checking back in on our ' + torWarnType + ' tornado warning, let\'s see what changed. ' + _build_tornado_revisit_update(feature, context));
        }
        var torSrc = _fn_arr(params.tornadoDetection) || '';
        if (torSrc.toLowerCase().includes('observed') || desc.includes('CONFIRMED')) {
            lines.push(_pick_random([
                'A tornado has been spotted on the ground near ' + area + '. This storm is confirmed dangerous and on the move.',
                'Storm spotters have confirmed a tornado in ' + area + '. This is not a drill. Take action now.',
                'We\'re looking at a confirmed tornado touching down in ' + area + ' ' + tod + '.',
                'A tornado is on the ground and has been visually confirmed near ' + area + '. This is an extremely dangerous storm.',
                'Eyewitnesses have reported a tornado in ' + area + ' ' + tod + '. This confirmation means the threat is real and immediate.',
                'A tornado has been confirmed near ' + area + ' by trained spotters. If you are anywhere near this storm, seek shelter immediately.',
                'This is not radar-only. A tornado has been confirmed on the ground near ' + area + '. Get to safety right now.'
            ]));
        } else if (torSrc.toLowerCase().includes('radar indicated') || desc.includes('RADAR INDICATED')) {
            lines.push(_pick_random([
                'Doppler radar is showing strong rotation in a thunderstorm near ' + area + '. No confirmed tornado at this time, but one could develop if conditions intensify.',
                'We\'re seeing a tight rotational signature on radar over ' + area + '. This is radar-indicated right now, and a tornado could form if the storm strengthens.',
                'Radar data shows a well-defined mesocyclone near ' + area + '. This warning is precautionary, and tornado potential increases if low-level rotation tightens.',
                'Strong rotation is being tracked on Doppler radar around ' + area + '. Treat this as a serious setup where a tornado could develop quickly if intensification continues.',
                'The radar presentation over ' + area + ' shows organized rotation. A tornado is not confirmed, but the environment can support rapid development.',
                'This is a radar-indicated tornado warning for ' + area + '. That means rotation is present and residents should be ready in case the storm ramps up.',
                'We\'re seeing a classic rotating storm signal near ' + area + '. Not confirmed on the ground, but this can escalate fast if the storm tightens further.'
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
            'If you\'re in the path of this storm, shelter immediately. Interior room, lowest floor, away from glass.',
            'Don\'t wait to see or hear it. Move to your safe room now and protect your head with pillows or a mattress.',
            'Your safest option is a basement or storm shelter. If neither is available, go to a small interior room on the lowest floor. Closet or bathroom.',
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
                'This isn\'t just a tornado threat. The storm is also producing ' + extras.join(' and ') + '.',
                'Even outside the tornado path, this storm carries ' + extras.join(' and ') + '. Stay sheltered.'
            ]));
        }
        if (motion) {
            lines.push(_pick_random([
                'This storm is tracking ' + _bearing_to_cardinal(motion.bearingDeg) + ' at ' + motion.speedMph + ' mph.',
                'The storm is moving ' + _bearing_to_cardinal(motion.bearingDeg) + ' at ' + motion.speedMph + ' miles per hour.',
                'Radar shows this cell pushing ' + _bearing_to_cardinal(motion.bearingDeg) + ' at roughly ' + motion.speedMph + ' mph.',
                'The supercell is progressing ' + _bearing_to_cardinal(motion.bearingDeg) + ' at ' + motion.speedMph + ' mph. Keep that direction in mind if you\'re downstream.',
                'Storm motion is ' + _bearing_to_cardinal(motion.bearingDeg) + ' at ' + motion.speedMph + ' mph. Anyone in that path should be in shelter already.'
            ]));
            if (city) {
                var cityDist = _city_distance_miles(motion, city);
                var etaMin = _city_eta_minutes(cityDist, motion.speedMph);
                if (etaMin && etaMin > 0 && etaMin < 120) {
                    lines.push(_pick_random([
                        'At current speed, this storm could reach ' + city.name + ' in approximately ' + etaMin + ' minutes.',
                        city.name + ' is about ' + Math.round(cityDist) + ' miles downrange, roughly ' + etaMin + ' minutes away at this pace.',
                        'The projected path puts ' + city.name + ' in the crosshairs in roughly ' + etaMin + ' minutes.',
                        'Residents of ' + city.name + ' should prepare now. The storm is estimated to arrive in about ' + etaMin + ' minutes.',
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
            'Severe weather is impacting ' + area + ' right now. A strong thunderstorm is moving through the area.',
            'The National Weather Service is tracking a dangerous thunderstorm affecting ' + area + ' ' + tod + '.',
            'We\'ve got a severe thunderstorm warning in effect for ' + area + '. This storm means business ' + tod + '.',
            'A severe-warned storm is hammering ' + area + ' right now. Let\'s take a closer look at the threats.',
            'Heads up for ' + area + '. The NWS has issued a severe thunderstorm warning as a potent cell moves through the region ' + tod + '.',
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
                    'destructive ' + hailNum.toFixed(2) + '" hail, that\'s baseball size'
                ]));
                else if (hailNum >= 1.75) threats.push(_pick_random([
                    'large hail up to ' + hailNum.toFixed(2) + '", nearly baseball size',
                    'significant hail at ' + hailNum.toFixed(2) + '", approaching baseball territory',
                    hailNum.toFixed(2) + '" hail, large enough to cause serious vehicle damage'
                ]));
                else if (hailNum >= 1.0) threats.push(_pick_random([
                    'golf ball to quarter-sized hail at ' + hailNum.toFixed(2) + '"',
                    'sizeable hailstones up to ' + hailNum.toFixed(2) + '"',
                    hailNum.toFixed(2) + '" hail, enough to dent cars and crack windshields'
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
                'Baseball-sized hail is a genuine danger. Get vehicles under cover and stay indoors.',
                'Hailstones this large can total a car in seconds and break through skylights. This is not something to watch from the porch.',
                'We\'re talking about ice the size of baseballs falling from the sky. If you have a garage, use it. If you don\'t, stay far from windows.',
                'At this size, hail becomes a projectile. It can injure or kill. Do not go outside to observe this storm.'
            ]));
        }

        if (torPossible) {
            lines.push(_pick_random([
                'Notably, this storm carries a tornado possible tag. Be prepared to shelter if a tornado warning is issued.',
                'The NWS has flagged this storm for possible tornado development. Stay alert for an upgrade to a tornado warning.',
                'There\'s a tornado threat embedded in this storm. Keep a close eye on it and be ready to take cover.',
                'This one also has a tornado possible flag, meaning the rotation is borderline. An upgrade to a tornado warning could come at any moment.',
                'Don\'t ignore the tornado possible tag on this warning. It means the storm is showing enough rotation that forecasters are concerned.',
                'The tornado possible tag means this storm has the ingredients to spin up a tornado. Have your safe room plan ready to go.'
            ]));
        } else {
            lines.push(_pick_random([
                'Stay inside and away from windows until the storm clears your area.',
                'If you\'re outdoors, get inside a solid structure. If driving, pull off the road and keep your seatbelt on.',
                'The best protection is to be inside a well-built structure away from exterior walls and glass.',
                'Keep away from windows and glass doors. The biggest threat from these storms is flying debris and sudden wind gusts.',
                'If you\'re on the road, don\'t park under an overpass. Find a sturdy building to shelter in. Overpasses actually funnel wind.',
                'Wait for this one to pass before heading back outside. These storms can produce sudden downbursts with very little lead time.'
            ]));
        }
    } else if (event === 'Flash Flood Warning') {
        lines.push(_pick_random([
            'Flash flooding is occurring or developing rapidly across ' + area + ' ' + tod + '.',
            'Dangerous flash flooding is threatening ' + area + '. Water levels are rising fast.',
            'The NWS has issued a flash flood warning for ' + area + ' as heavy rain continues to saturate the region.',
            'We\'re tracking a flash flood emergency across ' + area + '. Water is rising rapidly and conditions are deteriorating.',
            'Heavy rainfall has overwhelmed drainage across ' + area + ', and flash flooding is now in progress.',
            'A flash flood warning is active for ' + area + ' ' + tod + '. Rainfall rates have exceeded what the ground can absorb.',
            'Flooding conditions are unfolding quickly in ' + area + '. Streams, creeks, and urban areas are especially vulnerable right now.'
        ]));
        var dmg = _fn_arr(params.flashFloodDamageThreat);
        if (dmg && dmg.toUpperCase() === 'CATASTROPHIC') {
            lines.push(_pick_random([
                'This is a CATASTROPHIC flooding event. Expect life-threatening inundation of roads, structures, and low-lying areas.',
                'The damage threat is rated CATASTROPHIC. This is as serious as flash flooding gets. Evacuate if told to do so.',
                'We\'re looking at a rare catastrophic flash flood. Rescue operations may become necessary.',
                'The NWS is calling this CATASTROPHIC. That\'s the highest damage tier. Expect impassable roads, structural flooding, and swift-water rescues.',
                'A catastrophic flash flood event is underway. This has the potential to be a historic flood for ' + area + '.',
                'When the NWS uses the word catastrophic, they\'re not exaggerating. This is an extremely dangerous and potentially deadly flood situation.'
            ]));
        } else if (dmg && dmg.toUpperCase() === 'CONSIDERABLE') {
            lines.push(_pick_random([
                'Significant flooding of roadways and low-lying areas is expected. Some structures near waterways could sustain damage.',
                'The damage threat is considerable. Creeks and streams are overflowing and roads are becoming impassable.',
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
            'Stay off roads after dark in flooded areas. You cannot gauge water depth at night. Many fatal flood drownings happen after sunset.'
        ]));
    } else if (event === 'Evacuation - Immediate') {
        lines.push(_pick_random([
            'An IMMEDIATE EVACUATION order has been issued for ' + area + '. This is not a drill. Leave the area now.',
            'Emergency management has ordered an immediate evacuation of ' + area + '. Life-threatening conditions are present or imminent.',
            'A mandatory evacuation is in effect for ' + area + '. Residents must leave immediately for their own safety.',
            'This is an emergency evacuation order for ' + area + '. Drop everything and get out. Your safety depends on immediate action.',
            'Officials have ordered everyone in ' + area + ' to evacuate immediately. Life-threatening conditions are expected to escalate rapidly.',
            'An urgent evacuation order has been activated for ' + area + '. Do not wait for further updates. Leave now.'
        ]));
        if (desc.includes('FLOOD') || desc.includes('DAM') || desc.includes('LEVEE') || desc.includes('WATER')) {
            lines.push(_pick_random([
                'This evacuation is driven by dangerous flooding conditions. Rising water levels pose an imminent threat to life and property.',
                'Floodwaters are threatening the area. Roads may become impassable at any moment. Do not delay your departure.',
                'Water is rising rapidly in the evacuation zone. Get to higher ground and away from waterways immediately.',
                'A dam, levee, or waterway is threatening to overflow or has already breached. The resulting flood surge could be swift and deadly.',
                'Floodwaters are extremely deceptive. They move faster and carry more force than they appear. Evacuate to high ground now.',
                'The water threat in this area is escalating. Infrastructure failures could send a wall of water through the evacuation zone at any time.'
            ]));
        } else if (desc.includes('FIRE') || desc.includes('WILDFIRE')) {
            lines.push(_pick_random([
                'A fast-moving wildfire is threatening the area. Flames and smoke can overtake roads quickly. Evacuate now.',
                'Fire conditions are extreme and the threat to life is imminent. Follow your evacuation route without delay.',
                'This fire is moving rapidly. Grab essential items and leave immediately. Do not wait for further notice.',
                'Wind-driven fire can travel faster than you can drive on congested roads. Do not underestimate how quickly this fire can spread.',
                'Smoke alone can be deadly. Even if you can\'t see flames, evacuate immediately. Toxic fumes can incapacitate you in minutes.',
                'Embers from this fire can travel miles ahead of the main front. The entire area is at risk.'
            ]));
        } else {
            lines.push(_pick_random([
                'Conditions in the area are deteriorating rapidly. Follow instructions from local emergency management.',
                'The situation is considered life-threatening. Evacuate immediately using designated routes.',
                'Do not ignore this order. Gather your family, essential medications, and important documents, and leave the area now.',
                'Local authorities have determined that remaining in the area poses an immediate danger to your life. Comply with this evacuation order.',
                'Time is critical. Conditions may prevent evacuation if you delay. Leave while routes are still passable.',
                'This evacuation is mandatory, meaning officials believe the threat is severe enough that staying could result in death or serious injury.'
            ]));
        }
        lines.push(_pick_random([
            'If you need shelter, contact local emergency services or tune to local media for evacuation routes and shelter locations.',
            'Take phone chargers, medications, pets, and important documents with you. Check on your neighbors before you leave.',
            'Follow designated evacuation routes. Do not take shortcuts. They may be blocked or dangerous.',
            'Head to the nearest evacuation shelter. If you need transportation assistance, call 911 or your local emergency number.',
            'Bring a go-bag with essentials: water, medications, phone charger, ID, cash, and a change of clothes. Help elderly or disabled neighbors if you can.',
            'Lock your home, turn off utilities if you have time, and take your evacuation route. Traffic will be heavy. Stay patient and stay on route.'
        ]));
    } else if (event === 'Special Weather Statement') {
        lines.push(_pick_random([
            'A Special Weather Statement is active for ' + area + ' ' + tod + '. Conditions are hazardous, even if this is below warning criteria.',
            'The National Weather Service has issued a Special Weather Statement for ' + area + '. This is a heads-up for impactful weather in progress.',
            'We are tracking a Special Weather Statement across ' + area + ' right now, signaling notable weather hazards nearby.',
            'A Special Weather Statement is in effect for ' + area + '. This often means strong storms, reduced visibility, or other short-fuse hazards.',
            'Heads up for ' + area + ': a Special Weather Statement is active ' + tod + '. Impacts may increase quickly in this area.'
        ]));
        if (wind || (hail && !isNaN(hailNum) && hailNum > 0)) {
            var swsThreats = [];
            if (wind) swsThreats.push('wind gusts up to ' + wind);
            if (hail && !isNaN(hailNum) && hailNum > 0) swsThreats.push(hailNum.toFixed(2) + '" hail');
            lines.push(_pick_random([
                'Main impacts include ' + swsThreats.join(' and ') + '.',
                'The statement highlights ' + swsThreats.join(' and ') + ' as the primary threats.',
                'Expect pockets of ' + swsThreats.join(' and ') + ' with this cell.'
            ]));
        } else {
            lines.push(_pick_random([
                'Even without a formal warning, this can still produce dangerous travel and outdoor conditions.',
                'These statements are often issued ahead of stronger impacts, so stay weather-aware through the next hour.',
                'Treat this as an early warning signal and monitor radar closely for any upgrades.'
            ]));
        }
        lines.push(_pick_random([
            'If you are outdoors, move inside until this passes.',
            'Stay off exposed roads if heavy rain, gusty winds, or lightning move into your area.',
            'Keep your weather alerts on. A warning upgrade can happen quickly if conditions intensify.'
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
        var props = features[i]?.properties || {};
        var lbl = String(props.label || '');
        var lbl2 = String(props.label2 || '').toLowerCase();
        var n = parseFloat(lbl);
        if (!isNaN(n)) {
            if (n > 0 && n <= 1) n = Math.round(n * 100);
            if (n > maxPct) maxPct = n;
        }
        if (lbl.toLowerCase().indexOf('hatched') !== -1 || lbl2.indexOf('hatched') !== -1 || lbl2.indexOf('significant') !== -1) hasHatched = true;
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
                'The SPC has issued a rare HIGH RISK. This only happens a handful of times each year. All modes of severe weather are expected, including violent tornadoes.',
                'This is one of the most dangerous days on the calendar. A HIGH RISK means widespread, significant severe weather is virtually certain.',
                'A HIGH RISK day is as serious as it gets. The SPC is expecting a major severe weather outbreak with life-threatening hazards across the risk area.',
                'We are looking at a HIGH RISK from the SPC ' + tod + '. This is an exceptionally rare outlook level that signals a high-end, potentially historic severe weather event.',
                'The Storm Prediction Center has pulled the trigger on a HIGH RISK. This is reserved for the most extreme setups. Major tornado outbreaks, widespread destructive winds, and giant hail.',
                'A HIGH RISK is staring us in the face ' + tod + '. The atmosphere is loaded with energy. Extreme instability, powerful shear, and a volatile synoptic setup.'
            ]));
            var highContext = _pick_random([
                'The upper-level jet stream is providing exceptional wind shear, and surface moisture is off the charts.',
                'A powerful low-pressure system and associated warm front are creating explosive conditions across the risk area.',
                'All the ingredients are aligned. A vigorous shortwave, rich Gulf moisture, and a strongly sheared environment.',
                '', ''
            ]);
            if (highContext) lines.push(highContext);
            lines.push(_pick_random([
                'Everyone in the highlighted area should have shelter plans ready and multiple ways to receive warnings.',
                'This is a day to stay vigilant from start to finish. Tornadoes, destructive winds, and very large hail are all on the table.',
                'If you live in the risk area, charge your devices, know your safe room, and stay glued to weather updates.',
                'Please take this seriously. A HIGH RISK day means you need a plan, a shelter, and situational awareness from now until the threat passes.',
                'Storm chasers will be out in force, but for everyone else, the safest place is indoors with a way to receive real-time warnings.',
                'This is not a day to be caught off-guard. Violent tornadoes, destructive hail, and widespread damaging winds are all expected.'
            ]));
        } else if (highest === 'MDT') {
            lines.push(_pick_random([
                'A MODERATE RISK is on the board ' + tod + '. The SPC expects widespread severe storms, and significant events are likely.',
                'The SPC has elevated the outlook to MODERATE. That\'s a clear signal that a noteworthy severe weather event is unfolding.',
                'We\'re seeing a Moderate risk from the SPC, which tells us the atmosphere is primed for a serious round of severe weather.',
                'A Moderate risk has been issued ' + tod + ', and historically, these days produce some of the most impactful severe weather events of the year.',
                'The SPC is highlighting a MODERATE RISK. This tier is only issued a few dozen times per year. The threat level is significant.',
                'We\'re dealing with a Moderate risk ' + tod + '. The ingredients are coming together for a substantial severe weather event across the highlighted area.',
                'A MODERATE RISK from the Storm Prediction Center. The atmosphere is ripe with strong shear, ample moisture, and a forcing mechanism to kick things off.'
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
                'Don\'t underestimate a Moderate risk day. Some of the worst outbreaks in history have occurred under this category.',
                'If you\'re in the risk area, now is the time to prepare. Know where your shelter is and keep your phone charged for alerts.',
                'With a Moderate risk in play, expect storm reports to come in fast as the day progresses. Have multiple sources for weather information.',
                'Emergency managers in the affected area should be on high alert. This has the potential to be a high-impact event.'
            ]));
        } else if (highest === 'ENH') {
            lines.push(_pick_random([
                'An ENHANCED RISK is highlighted for today, meaning numerous severe storms are expected with the potential for a few significant ones.',
                'The SPC outlook shows an Enhanced risk ' + tod + '. This is a step above Slight, and severe weather is becoming increasingly likely.',
                'We\'re tracking an Enhanced risk from the Storm Prediction Center. Multiple rounds of organized severe storms could impact the region.',
                'An Enhanced risk is in play ' + tod + '. The SPC sees enough ingredients for a concentrated area of severe thunderstorms.',
                'The Day 1 outlook has been upgraded to Enhanced. Forecasters have growing confidence in a more organized severe weather event.',
                'We\'re looking at an ENHANCED RISK across the outlook area. Surface boundaries and upper-level energy are coming together to support widespread severe storms.',
                'An Enhanced risk from the SPC means we should see a noticeable step up in storm coverage and intensity compared to a Slight risk day.'
            ]));
            lines.push(_pick_random([
                'Now is a good time to review your severe weather plan and know where your nearest shelter is.',
                'Keep an eye on radar through the day. Storms could ramp up quickly once they fire.',
                'Have a way to receive warnings even while sleeping, as threats may persist into the night.',
                'Stay tuned for mesoscale discussions and potential watch issuances from the SPC as the day progresses.',
                'If you have outdoor plans in the risk area, consider flexible alternatives. Storms could develop rapidly.',
                'This is the kind of day where you want your weather radio on and your phone alerts enabled.'
            ]));
        } else if (highest === 'SLGT') {
            lines.push(_pick_random([
                'The Day 1 outlook features a SLIGHT RISK, which means scattered severe storms are possible ' + tod + ' with isolated tornadoes, hail, and damaging winds.',
                'A Slight risk is in play. Not a guarantee of severe weather in any one spot, but enough ingredients are present for organized storms to produce hazards.',
                'The SPC has placed parts of the country under a Slight risk. A few storms could turn severe as the day progresses.',
                'We\'re tracking a Slight risk ' + tod + '. While it\'s the middle tier, a Slight risk can still produce a few dangerous storms. Don\'t let the name fool you.',
                'A SLIGHT RISK is on the map, and while it doesn\'t scream catastrophe, it does mean some storms will pack a punch.',
                'The SPC has highlighted a Slight risk for portions of the region. Isolated to scattered severe storms are expected, with all hazard types possible.',
                'A Slight risk day means scattered severe weather. A handful of storms could produce damaging winds, hail, or even a brief tornado.'
            ]));
        } else if (highest === 'MRGL') {
            lines.push(_pick_random([
                'A MARGINAL RISK is outlined for today, the lowest tier of severe risk. An isolated storm or two could briefly reach severe limits.',
                'We\'re looking at a Marginal risk, meaning the severe weather threat is low but not zero. A stray damaging gust or hail report is possible.',
                'The SPC has painted a Marginal risk area on the outlook. Confidence in widespread severe weather is low, but stay aware if storms develop near you.',
                'A Marginal risk is on the board ' + tod + '. Think of it as a heads-up that a storm or two might get rowdy, but nothing widespread.',
                'The Day 1 outlook shows a Marginal risk. This is the SPC\'s way of saying the environment marginally supports a severe storm, but the odds are low.',
                'We\'re at the Marginal level on the SPC outlook, the lowest rung of severe risk. An isolated gusty storm or small hail event is about the extent of it.',
                'A Marginal risk is highlighted, but most people in the risk area probably won\'t see severe weather. It\'s just worth having on your radar.'
            ]));
        } else {
            lines.push(_pick_random([
                'The Day 1 outlook is showing general thunderstorm coverage, but no organized severe risk has been identified by the SPC.',
                'No categorical severe risk is outlined today. Any thunderstorms that develop should remain below severe criteria.',
                'It\'s a relatively quiet setup on the convective outlook. The SPC doesn\'t see the ingredients for widespread severe weather today.',
                'The SPC outlook is all green ' + tod + '. General thunderstorm areas only. The severe weather threat is essentially zero.',
                'Quiet day on the convective outlook. No severe risk areas have been highlighted by the Storm Prediction Center.',
                'The atmosphere is relatively stable ' + tod + ' with no organized severe potential. Enjoy the calm while it lasts.',
                'Nothing alarming on the Day 1 outlook. The SPC sees no real setup for severe weather across the lower 48 right now.'
            ]));
        }
    } else if (hazard === 'tornado') {
        var ts = _extract_spc_stats(features);
        if (ts.maxPct >= 30) {
            lines.push(_pick_random([
                'The tornado outlook is screaming danger. A ' + ts.maxPct + '% probability area signals a full-blown tornado outbreak is expected.',
                'At ' + ts.maxPct + '%, this is an exceptionally high tornado probability. Numerous strong to violent tornadoes are anticipated.',
                'This ' + ts.maxPct + '% tornado probability is historic-level. The atmosphere is loaded for a major outbreak.',
                'We are in rare territory with a ' + ts.maxPct + '% tornado probability. This is the kind of setup that produces long-track, violent tornadoes.',
                'The SPC has drawn a ' + ts.maxPct + '% tornado contour, and that is about as alarming as it gets. Multiple significant tornadoes are expected.',
                'At ' + ts.maxPct + '% tornado probability, the SPC is telling us to expect a prolific tornado event. EF3 or stronger tornadoes are a real possibility ' + tod + '.'
            ]));
            var torContext = _pick_random([
                'The low-level jet is screaming, and hodographs are massive. Textbook setup for long-track supercells.',
                'Extreme wind shear and a volatile warm sector are fueling this outbreak potential.',
                '', ''
            ]);
            if (torContext) lines.push(torContext);
        } else if (ts.maxPct >= 15) {
            lines.push(_pick_random([
                'A ' + ts.maxPct + '% tornado probability area is drawn on the outlook. Multiple tornadoes, including potentially strong ones, are expected.',
                'At ' + ts.maxPct + '%, the tornado threat is elevated well above average. Supercells with tornado potential will likely develop ' + tod + '.',
                'The SPC has highlighted a notable ' + ts.maxPct + '% tornado probability zone. Several tornadoes are possible, and some could be significant.',
                'A ' + ts.maxPct + '% tornado probability is noteworthy. This suggests discrete supercells capable of producing strong tornadoes within the highlighted area.',
                'The ' + ts.maxPct + '% tornado contour tells us the mesocyclone environment is favorable. Rotating storms are expected to develop ' + tod + '.',
                'We\'re looking at ' + ts.maxPct + '% tornado probabilities, which is a clear signal that storm chasers and emergency managers will be active today.',
                'At ' + ts.maxPct + '%, the tornado potential is significant. The low-level jet and shear profiles are strongly supportive of tornadic supercells.'
            ]));
        } else if (ts.maxPct >= 5) {
            lines.push(_pick_random([
                'A ' + ts.maxPct + '% tornado probability is in play. The environment supports supercell development with embedded tornado risk.',
                'The tornado outlook shows a ' + ts.maxPct + '% zone. Enough to warrant close attention. Isolated tornadoes are possible with the strongest storms.',
                'We\'re seeing ' + ts.maxPct + '% tornado probabilities on the Day 1 outlook. Any storm that can sustain rotation will bear watching.',
                'A ' + ts.maxPct + '% tornado probability area is outlined ' + tod + '. The hodographs and wind profiles suggest a window for brief tornadoes.',
                'The SPC is showing ' + ts.maxPct + '% for tornado. Not extreme, but definitely enough to have your weather radio on and shelter plan in mind.',
                'At ' + ts.maxPct + '% tornado probabilities, we could see a few isolated tornadoes if cells can tap into the low-level shear.'
            ]));
        } else if (ts.maxPct >= 2) {
            lines.push(_pick_random([
                'A ' + ts.maxPct + '% tornado probability is on the map. Low, but not negligible. Brief, weak tornadoes can still cause damage and injury.',
                'The tornado risk sits at ' + ts.maxPct + '%, which is on the lower end. Still, it only takes one tornado to ruin someone\'s day.',
                'Even at ' + ts.maxPct + '%, don\'t let your guard down. Tornadoes from low-probability setups can still be deadly if you\'re not prepared.',
                'A ' + ts.maxPct + '% tornado signal is on the outlook. It\'s a low-end threat, but a brief spin-up tornado can\'t be ruled out with the stronger cells.',
                'We\'re looking at ' + ts.maxPct + '% tornado probabilities. Relatively low, but these are the kind of setups that produce the occasional surprise tornado.',
                'At just ' + ts.maxPct + '%, the tornado threat is conditional, but the ingredients for a brief tornado are present if a storm can get its act together.'
            ]));
        } else if (features.length) {
            lines.push(_pick_random([
                'The SPC has outlined tornado probabilities, though overall confidence in tornado development remains low.',
                'Some tornado potential has been flagged, but the environment isn\'t fully supportive of widespread tornado activity.',
                'There\'s a non-zero tornado signal on the outlook. The risk is marginal, but worth monitoring if storms fire.',
                'A low-end tornado signal is present on the Day 1 outlook. The environment has some supportive ingredients, but the setup isn\'t robust.',
                'The SPC sees a slim chance of tornadoes ' + tod + '. The low-level wind fields are only weakly supportive.',
                'Tornado potential is on the fringe today. The atmosphere could support a brief, weak tornado, but most storms should remain non-tornadic.'
            ]));
        } else {
            lines.push(_pick_random([
                'No significant tornado probabilities are highlighted on the Day 1 outlook at this time.',
                'The tornado outlook is quiet. The ingredients for tornadic storms aren\'t coming together today.',
                'The SPC isn\'t seeing a meaningful tornado threat in the current forecast cycle.',
                'Good news on the tornado front. The Day 1 outlook shows no tornado probability contours today.',
                'No tornado risk to speak of ' + tod + '. The wind profiles don\'t support rotation in any developing storms.',
                'The tornado outlook is clean across the board. The atmosphere isn\'t set up for tornadic activity today.'
            ]));
        }
        if (ts.hasHatched) {
            lines.push(_pick_random([
                'The hatched contour means there\'s a 10%+ chance of EF2 or stronger tornadoes within 25 miles of any point inside it.',
                'Pay close attention to the hatched area. It flags a heightened risk of significant tornadoes, EF2 or stronger.',
                'Where you see hatching, the SPC is signaling that the strongest tornadoes are most likely to occur.',
                'That hatching on the map is critical. The SPC expects a 10% or greater chance of significant tornadoes, potentially long-track and violent.',
                'The hatched contour is where the real danger lies. EF2 or stronger tornadoes are expected within 25 miles of any point in that zone.',
                'Notice the hatching. That represents the significant severe parameter. This is where we could see the most intense and potentially deadly tornadoes.'
            ]));
        }
    } else if (hazard === 'wind') {
        var ws = _extract_spc_stats(features);
        if (ws.maxPct >= 30) {
            lines.push(_pick_random([
                'Widespread, destructive winds are expected ' + tod + '. A ' + ws.maxPct + '% probability area means a derecho-level event is possible.',
                'The wind outlook is extremely aggressive at ' + ws.maxPct + '%. Expect widespread tree and power line damage, and potentially worse.',
                'At ' + ws.maxPct + '%, the SPC is forecasting a prolific damaging wind event. Gusts above 75 mph are a genuine possibility.',
                'A ' + ws.maxPct + '% wind probability is exceptionally high. This setup favors a widespread, destructive wind event. Possibly a bow echo or derecho.',
                'The SPC has painted a ' + ws.maxPct + '% wind contour ' + tod + ', and that spells trouble. Large-scale damaging winds are virtually certain.',
                'At ' + ws.maxPct + '%, expect a major damaging wind event. Storms will likely organize into a squall line capable of producing hurricane-force gusts.',
                'This ' + ws.maxPct + '% wind probability is as high as it gets. Significant structural damage is possible across a wide swath.'
            ]));
        } else if (ws.maxPct >= 15) {
            lines.push(_pick_random([
                'A significant damaging wind threat is highlighted at ' + ws.maxPct + '%. Storms will be capable of producing widespread 60-80 mph gusts.',
                'The ' + ws.maxPct + '% wind probability tells us to expect numerous reports of damaging winds ' + tod + '. Secure outdoor objects.',
                'With ' + ws.maxPct + '% wind probabilities, clusters of severe storms will likely produce damaging outflow winds across a large area.',
                'The SPC is showing ' + ws.maxPct + '% wind probabilities. Organized convective wind damage is a primary threat ' + tod + '.',
                'A ' + ws.maxPct + '% wind probability means damaging straight-line winds will be a major concern. Storms may organize into a fast-moving squall line.',
                'At ' + ws.maxPct + '%, wind damage is going to be the headline story. Trees, power lines, and lightweight structures are all vulnerable.',
                'The ' + ws.maxPct + '% wind contour is broad enough to suggest a widespread damaging wind event rather than just isolated gusts.'
            ]));
        } else if (ws.maxPct >= 5) {
            lines.push(_pick_random([
                'A ' + ws.maxPct + '% damaging wind probability is on the outlook. Isolated to scattered severe gusts are possible with stronger thunderstorms.',
                'Wind damage is in the forecast at ' + ws.maxPct + '%. The main threat will be from storm outflow, gusts over 58 mph.',
                'The ' + ws.maxPct + '% wind zone highlights where thunderstorm downbursts could produce tree damage and localized power outages.',
                'A ' + ws.maxPct + '% wind probability means some storms ' + tod + ' will produce damaging downburst winds. Keep an eye on approaching lines.',
                'We\'re seeing ' + ws.maxPct + '% wind probabilities. Enough to warrant attention. Microbursts and strong outflow could produce locally damaging gusts.',
                'The wind threat sits at ' + ws.maxPct + '%. Not the highest we\'ve seen, but still capable of producing some nasty downbursts in the stronger cells.'
            ]));
        } else if (features.length) {
            lines.push(_pick_random([
                'Some wind risk has been identified, though overall confidence in a widespread damaging wind event is low.',
                'A marginal wind threat exists. A stray severe gust is possible but shouldn\'t be a major concern area-wide.',
                'The wind outlook shows limited probabilities. Any severe gusts would be isolated and brief.',
                'A low-end wind signal is present, but the setup doesn\'t favor any organized damaging wind event.',
                'The SPC notes some wind potential ' + tod + ', but it\'s on the fringe. An isolated strong gust at most.',
                'There\'s a marginal wind component to today\'s outlook, but it shouldn\'t be the primary concern.'
            ]));
        } else {
            lines.push(_pick_random([
                'No significant wind damage probabilities are highlighted today.',
                'The Day 1 wind outlook is clean. No meaningful damaging wind signal in the current data.',
                'Winds shouldn\'t be a major player in today\'s weather story.',
                'The wind outlook shows no concerning probabilities ' + tod + '. Gusty thunderstorm winds aren\'t expected.',
                'No damaging wind threat on the board. Storms, if any develop, should produce sub-severe gusts.',
                'The wind picture is quiet. The SPC doesn\'t see the ingredients for significant wind damage today.'
            ]));
        }
        if (ws.hasHatched) {
            lines.push(_pick_random([
                'The hatched area flags a 10%+ chance of 75 mph or stronger gusts. Those winds can cause structural damage.',
                'Where you see hatching, the risk of significant wind damage (75+ mph) is elevated. This can rival weak tornado damage.',
                'Inside the hatched zone, hurricane-force gusts above 75 mph are possible. Take these threats seriously.',
                'The hatched contour highlights where 75+ mph gusts are anticipated. Winds that can collapse roofs and snap utility poles.',
                'Pay special attention to the hatched area. Winds of 75 mph or greater can cause damage equivalent to an EF1 tornado.',
                'That hatching means business. We\'re talking about the potential for 75+ mph gusts, which is genuinely dangerous and destructive.'
            ]));
        }
    } else if (hazard === 'hail') {
        var hs = _extract_spc_stats(features);
        if (hs.maxPct >= 30) {
            lines.push(_pick_random([
                'A major hail event is expected ' + tod + '. The ' + hs.maxPct + '% probability area signals giant hail. Baseball-sized stones or larger are on the table.',
                'At ' + hs.maxPct + '%, the hail outlook is about as alarming as it gets. Expect significant property damage from very large hail.',
                'The SPC is forecasting extreme hail probabilities at ' + hs.maxPct + '%. Supercells will likely produce destructive hailstones exceeding 2 inches.',
                'A ' + hs.maxPct + '% hail probability is a big deal. This kind of setup produces the sort of hail that totals vehicles and punches through roofs.',
                'The SPC has drawn a ' + hs.maxPct + '% hail contour ' + tod + '. Supercell updrafts will be strong enough to loft enormous hailstones.',
                'At ' + hs.maxPct + '%, we are looking at a potentially devastating hail event. Baseball-sized or larger stones are expected with the most intense supercells.',
                'The hail threat is about as serious as it gets at ' + hs.maxPct + '%. Get your vehicles under cover if you can. The damage potential is extreme.'
            ]));
        } else if (hs.maxPct >= 15) {
            lines.push(_pick_random([
                'The hail threat is significant at ' + hs.maxPct + '%. Storms will be capable of producing large to very large hail, enough to damage vehicles and roofs.',
                'A ' + hs.maxPct + '% hail probability means supercells ' + tod + ' could drop golf ball-sized or larger hailstones across the highlighted area.',
                'With ' + hs.maxPct + '% hail probabilities, the SPC expects an active day for large hail reports across this region.',
                'The ' + hs.maxPct + '% hail probability tells us strong updrafts will support large hail production. Quarter to golf ball-sized stones are likely.',
                'At ' + hs.maxPct + '%, hail damage is going to be a primary concern. Keep vehicles sheltered and stay indoors when storms pass overhead.',
                'A ' + hs.maxPct + '% hail probability area is highlighted. The SPC expects these supercells to produce stones large enough to crack windshields.',
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
                'The hail outlook is quiet. The environment doesn\'t favor large hail production today.',
                'Large hail isn\'t on the menu for today\'s weather pattern.',
                'The hail outlook is clean ' + tod + '. Storms, if any, shouldn\'t produce significant hail.',
                'No hail worries today. The updraft potential isn\'t strong enough to support large stones.',
                'Hail is a non-factor on today\'s outlook. The environment just doesn\'t support it.'
            ]));
        }
        if (hs.hasHatched) {
            lines.push(_pick_random([
                'Hatching denotes a 10%+ chance of 2-inch or larger hail. Stones that size can cause serious injury and total a vehicle.',
                'The hatched area is where the very largest hail is expected. This is a significant threat to anyone caught outside.',
                'Inside the hatched contour, expect the potential for truly destructive hail, 2 inches or larger in diameter.',
                'That hatching means 2-inch-plus hail is expected. We\'re talking baseball-sized stones that can be lethal if you\'re caught outside.',
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
        'Keep it right here. We\'re tracking this around the clock.'
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
        'Time to take the big-picture view. Here\'s the national MRMS radar composite across the continental U.S.',
        'Stepping back to the nationwide radar mosaic ' + tod + '. Let\'s see what\'s going on coast to coast.',
        'Here\'s the full continental view on MRMS reflectivity. A great way to see the overall pattern.',
        'Zooming out to the national scale ' + tod + '. The MRMS composite gives us the best picture of precipitation across the entire country.'
    ]));

    if (total === 0) {
        lines.push(_pick_random([
            'No active severe weather warnings across the nation right now. A relatively calm pattern is in place.',
            'It\'s quiet out there ' + tod + '. No severe thunderstorm, tornado, or flash flood warnings active.',
            'The warning map is clean at the moment. No severe weather warnings are currently in effect nationwide.',
            'No severe warnings anywhere across the lower 48 right now. A nice break from the action.',
            'The national warning count sits at zero ' + tod + '. The atmosphere is behaving itself for now.',
            'All clear on the severe weather front. Not a single tornado, severe thunderstorm, or flash flood warning active across the country.',
            'A quiet pattern is in control nationwide ' + tod + '. No active severe weather warnings to report.'
        ]));
        var quietNote = _pick_random([
            '', '', '', '',
            ' Days like this are a good reminder to review your severe weather plan for when things do ramp up.',
            ' Enjoy the calm. It never lasts forever in the weather world.',
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
                'Plenty of action on the board. ' + parts.join(', ') + '. A widespread severe weather event is underway.',
                'We\'re tracking a very active pattern with ' + parts.join(', ') + ' spanning multiple states. A lot happening at once.',
                'The severe weather machine is running full speed ' + tod + '. We\'ve got ' + parts.join(', ') + ' across the nation.'
            ]));
        } else if (total >= 4) {
            lines.push(_pick_random([
                'Several warnings are active right now: ' + parts.join(', ') + '. Multiple storm clusters are producing hazardous conditions.',
                'A moderate level of activity on the warning map with ' + parts.join(', ') + '. Several areas need to stay alert.',
                'We\'re tracking ' + parts.join(', ') + ' ' + tod + '. A handful of storm complexes are causing trouble.',
                'The warning count is climbing. ' + parts.join(', ') + ' across the country. Multiple areas are being impacted.',
                'Active weather across parts of the country with ' + parts.join(', ') + ' on the board.'
            ]));
        } else {
            lines.push(_pick_random([
                'Currently tracking ' + parts.join(' and ') + ' across the US.',
                'A few warnings are active ' + tod + ': ' + parts.join(' and ') + '.',
                'We\'ve got ' + parts.join(' and ') + ' on the map right now. Let\'s keep an eye on those.',
                'Light activity on the warning map with ' + parts.join(' and ') + ' currently in effect.',
                'The warning count is low but not zero. Tracking ' + parts.join(' and ') + ' ' + tod + '.'
            ]));
        }

        if (torCount >= 3) {
            lines.push(_pick_random([
                'With multiple tornado warnings active, this is a particularly dangerous weather situation unfolding in real time.',
                'The tornado threat is elevated across multiple locations. Stay tuned for rapid developments.',
                'Several tornado-warned storms are on the map. That\'s a sign of an active severe weather event in progress.',
                'Multiple tornado warnings at the same time. That\'s a hallmark of a significant severe weather outbreak.',
                torCount + ' tornado warnings are active at once. This is the kind of situation where you stay glued to your weather sources.',
                'The tornado count is alarming. ' + torCount + ' active warnings tells us this is a serious and ongoing outbreak.'
            ]));
        } else if (torCount > 0) {
            lines.push(_pick_random([
                'At least one tornado warning is active. We\'ll focus in on that threat shortly.',
                'A tornado-warned storm is being tracked. Anyone in the warned area should be in shelter.',
                'With a tornado warning on the board, conditions are dangerous for parts of the country right now.',
                'There\'s a tornado warning active. We\'ll be zooming in on that shortly for a closer look.',
                'A confirmed tornado threat is on the map. If you\'re in the warned polygon, take shelter immediately.',
                'We\'ve got a tornado warning to keep our eye on. Stand by for a closer look at that storm.'
            ]));
        }
    }

    return lines.join(' ');
}

function _build_live_alert_html(feature, radarStation) {
    var p = feature.properties || {};
    var event = p.event || 'Alert';
    var hexColor = '#ff4444';
    try { hexColor = chroma(get_polygon_colors(event).color).hex(); } catch (_) {}
    var params = _parse_alert_params(feature);
    var desc = (p.description || '').toUpperCase();
    var nwsHeadlineUpper = String(_fn_arr(params.NWSheadline) || '').toUpperCase();
    var tornadoDamageThreatUpper = String(_fn_arr(params.tornadoDamageThreat) || '').toUpperCase();
    var severeDamageThreatUpper = String(_fn_arr(params.thunderstormDamageThreat) || _fn_arr(params.damageThreat) || '').toUpperCase();
    var isTor = TORNADO_EVENTS.includes(event);
    var isConvective = ['Tornado Emergency', 'PDS Tornado Warning', 'Tornado Warning',
        'Severe Thunderstorm Warning', 'Severe Thunderstorm Watch', 'Tornado Watch',
        'Special Weather Statement'].indexOf(event) !== -1;

    var pills = [];
    function _get_tone_from_text(text) {
        var t = String(text || '').toUpperCase();
        if (!t) return '';
        if (t.includes('TORNADO EMERGENCY') || t === 'PDS') return 'magenta';
        if (t.includes('DESTRUCTIVE')) return 'danger';
        if (t.includes('OBSERVED')) return 'danger';
        if (t.includes('CONSIDERABLE')) return 'warning';
        if (t.includes('RADAR INDICATED')) return 'warning';
        if (t.includes('TORNADO POSSIBLE') || t.includes('POSSIBLE TORNADO') || t === 'POSSIBLE') return 'warning';
        return '';
    }
    function _push_pill(text, tone) {
        if (!text) return;
        pills.push({
            text: String(text).toUpperCase(),
            tone: tone || _get_tone_from_text(text)
        });
    }
    function _extract_nws_source_text(description) {
        if (!description) return '';
        var match = description.match(/SOURCE\.\.\.([\s\S]+?)(?=\n\n|HAZARD\.\.\.|IMPACT\.\.\.|$)/i);
        if (!match || !match[1]) return '';
        return String(match[1]).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function _get_tornado_panel_status() {
        var torDetection = String(_fn_arr(params.tornadoDetection) || '').toUpperCase();
        // Use only NWS-provided headline/parameter fields for status.
        if (nwsHeadlineUpper.includes('TORNADO EMERGENCY') || tornadoDamageThreatUpper === 'CATASTROPHIC') {
            return 'TORNADO EMERGENCY';
        }
        if (tornadoDamageThreatUpper === 'CONSIDERABLE') {
            return 'PDS';
        }
        if (torDetection.includes('OBSERVED')) {
            return 'OBSERVED';
        }
        if (torDetection.includes('RADAR INDICATED')) {
            return 'RADAR INDICATED';
        }
        return '';
    }

    if (isTor) {
        var tornadoPanelStatus = _get_tornado_panel_status();
        if (tornadoPanelStatus) _push_pill(tornadoPanelStatus);
    }

    if (event === 'Severe Thunderstorm Warning') {
        var stwTornadoDetection = _fn_arr(params.tornadoDetection);
        var hasTornadoPossibleTag = (stwTornadoDetection && String(stwTornadoDetection).toUpperCase().includes('POSSIBLE'))
            || desc.includes('TORNADO POSSIBLE')
            || desc.includes('POSSIBLE TORNADO');
        if (hasTornadoPossibleTag) _push_pill('TORNADO POSSIBLE', 'warning');
    }

    var windVal = _fn_arr(params.maxWindGust);
    if (isConvective && windVal) _push_pill(windVal);

    var hailVal = _fn_arr(params.maxHailSize);
    var hailNum = parseFloat(hailVal);
    if (isConvective && hailVal && !isNaN(hailNum) && hailNum > 0) {
        _push_pill(hailNum.toFixed(2) + '" HAIL');
    }

    var damageThreat = _fn_arr(params.flashFloodDamageThreat) || _fn_arr(params.damageThreat);
    if (damageThreat && event !== 'Severe Thunderstorm Warning') _push_pill(damageThreat.toUpperCase());

    var areaDesc = p.areaDesc || '';

    var sourceStr = '';
    if (isTor) {
        // Prefer official NWS SOURCE... text for the source row.
        sourceStr = _extract_nws_source_text(p.description || '');
        if (!sourceStr) {
            var torDetectionRaw = String(_fn_arr(params.tornadoDetection) || '').toUpperCase();
            if (torDetectionRaw.includes('RADAR INDICATED')) sourceStr = 'Radar indicated.';
            else if (torDetectionRaw.includes('OBSERVED')) sourceStr = 'Observed.';
        }
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
            var pill = pills[i];
            var pillToneClass = pill.tone ? ' fnAlertPill-' + pill.tone : '';
            html += '<span class="fnAlertPill' + pillToneClass + '">' + pill.text + '</span>';
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

    if (event === 'Severe Thunderstorm Warning'
        && (severeDamageThreatUpper === 'CONSIDERABLE' || severeDamageThreatUpper === 'DESTRUCTIVE')) {
        html += '<div class="fnAlertRow">';
        html += '<span class="fnAlertRowLabel">Storm</span>';
        var stormToneClass = severeDamageThreatUpper === 'DESTRUCTIVE'
            ? ' fnAlertRowValue-danger'
            : ' fnAlertRowValue-warning';
        html += '<span class="fnAlertRowValue' + stormToneClass + '">' + severeDamageThreatUpper + '</span>';
        html += '</div>';
    }

    if (sourceStr) {
        html += '<div class="fnAlertRow">';
        html += '<span class="fnAlertRowLabel">Source</span>';
        html += '<span class="fnAlertRowValue">' + sourceStr + '</span>';
        html += '</div>';
    }

    var expiresRaw = p.expires || p.ends;
    if (expiresRaw) {
        var expiresMs = new Date(expiresRaw).getTime();
        if (Number.isFinite(expiresMs)) {
            var nowMs = Date.now();
            var diffMs = expiresMs - nowMs;
            var expiresText = '';
            if (diffMs <= 0) {
                expiresText = 'Expired.';
            } else {
                var totalMin = Math.floor(diffMs / 60000);
                var hours = Math.floor(totalMin / 60);
                var mins = totalMin % 60;
                var durationParts = [];
                if (hours > 0) durationParts.push(hours + ' hour' + (hours === 1 ? '' : 's'));
                if (mins > 0 || !durationParts.length) durationParts.push(mins + ' minute' + (mins === 1 ? '' : 's'));
                var stationCode = radarStation || window.stormTrackData?.currentStation || null;
                var timeZone = '';
                var expiresClock = '';
                if (stationCode) {
                    try { timeZone = get_station_timezone(stationCode); } catch (_) {}
                }
                try {
                    var clockOpts = {
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true,
                        timeZoneName: 'short'
                    };
                    if (timeZone) clockOpts.timeZone = timeZone;
                    expiresClock = new Intl.DateTimeFormat('en-US', clockOpts).format(new Date(expiresMs));
                } catch (_) {
                    expiresClock = new Date(expiresMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                }
                expiresText = 'In ' + durationParts.join(' ') + '.';
                if (expiresClock) expiresText += ' At ' + expiresClock + '.';
            }
            html += '<div class="fnAlertRow">';
            html += '<span class="fnAlertRowLabel">Expires</span>';
            html += '<span class="fnAlertRowValue">' + expiresText + '</span>';
            html += '</div>';
        }
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

function _build_conus_panel_html(regionLabel) {
    var html = '<div class="fnAlert" style="--fn-accent:#22c55e">';
    html += '<div class="fnAlertShine"></div>';
    html += '<div class="fnAlertBody">';
    html += '<div class="fnAlertEventName">CONUS MRMS RADAR</div>';
    if (regionLabel) {
        html += '<div class="fnAlertSourceLine" style="margin-top:4px;opacity:0.75">Regional Focus: ' + regionLabel + '</div>';
    }
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
    _set_segment_stage('enter');

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
        _set_segment_stage('finish');
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
    var alertContext = null;
    if (!feature) {
        var picked = _pick_alert_focus_feature(alerts);
        feature = picked.feature;
        alertContext = picked.context;
    } else {
        alertContext = _get_alert_focus_context(feature);
    }
    if (!feature) return resolve();
    _set_segment_stage('focus');

    _record_segment('alert', feature.id || feature?.properties?.id);
    if (alertContext) _mark_alert_focus_visit(feature, alertContext);

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
        station_markers.selectStation(station, nexrad_locations[station].type || 'WSR-88D', { persist: false });
        _show_radar_render();
        _show_station_markers();
        _show_alert_polygons();
        _show_radar_sweep();
        _show_lightning_overlay();
        _show_header_radar_info({ force: true });
        if (isSameStation && controller && controller.state.active && controller.state.supported) {
            controller.refresh_frames();
        }
    }

    _fly_to_alert(feature);
    _add_focus_glow(feature);
    _show_info_panel(_build_live_alert_html(feature, station));

    var torEligible = _is_tornado_eligible(feature);
    var isTornado = TORNADO_EVENTS.includes(feature?.properties?.event || '');
    var motion = isTornado ? _extract_storm_motion(feature) : null;

    // Keep motion/path logic for commentary targeting, but do not render the track overlay.

    if (isTornado && motion) {
        _set_segment_stage('commentary');
        _find_city_in_storm_path(feature, motion, function (city) {
            if (isStale()) return;
            try {
                _typewrite(_generate_alert_commentary(feature, motion, city, alertContext), 1200);
            } catch (err) {
                console.warn('[LiveMode] Alert commentary rendering failed', err);
                _stop_typewriter();
            }
        });
    } else {
        _set_segment_stage('commentary');
        try {
            _typewrite(_generate_alert_commentary(feature, null, null, alertContext), 1200);
        } catch (err) {
            console.warn('[LiveMode] Alert commentary rendering failed', err);
            _stop_typewriter();
        }
    }

    function _begin_playback() {
        if (isStale()) return finish();
        _set_segment_stage('playback');
        _run_playback(epoch, function () {
            if (isStale()) return finish();
            if (torEligible) {
                _set_segment_stage('velocity');
                _switch_to_velocity(epoch, feature, function () {
                    if (isStale()) return finish();
                    _reset_to_reflectivity();
                    _set_segment_stage('wait-text');
                    _wait_for_typewriter_then(function () {
                        if (isStale()) return finish();
                        finish();
                    });
                });
            } else {
                _set_segment_stage('wait-text');
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
        _set_segment_stage('wait-scan');
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
        _set_segment_stage('timeout');
        finish();
    }, 90000);
}

// ── Radar Playback Sub-Segment ───────────────────────────────────────────────

function _run_playback(epoch, done) {
    var controller = window.stormTrackData?.radarLoopController;
    if (!controller) return done();

    function isStale() { return epoch !== _alertEpoch || !_active; }

    var _playbackDone = false;
    _set_segment_stage('playback-init');
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
            _set_segment_stage('playback-wait');
            if (_waitAttempts < 60) { _waitAttempts++; _trackAlertTimer(_try_play, 400); }
            else finish();
            return;
        }
        if (loopState.preloading) {
            _set_segment_stage('playback-preload');
            if (_waitAttempts < 60) { _waitAttempts++; _trackAlertTimer(_try_play, 400); }
            else finish();
            return;
        }
        if (!loopState.frames || loopState.frames.length === 0) {
            _set_segment_stage('playback-frames');
            if (_waitAttempts < 60) { _waitAttempts++; _trackAlertTimer(_try_play, 400); }
            else finish();
            return;
        }
        _set_segment_stage('playback-loop');
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
    var finished = false;
    function finish_once() {
        if (finished) return;
        finished = true;
        _cleanup_scan_load_listener();
        _set_segment_stage('velocity-done');
        done();
    }
    function _is_base_velocity_product(product) {
        var p = String(product || '').toUpperCase();
        return p === 'VEL' || p === 'N0G' || p === 'N1G' || p === 'N2G' || p === 'N3G' ||
            p === 'N0U' || p === 'N1U' || p === 'N2U' || p === 'N3U' ||
            p === 'TV0' || p === 'TV1' || p === 'TV2' ||
            p.indexOf('P99V') === 0;
    }
    function _is_storm_relative_product(product) {
        var p = String(product || '').toUpperCase();
        return p === 'N0S' || p === 'N1S' || p === 'N2S' || p === 'N3S';
    }

    var $velRow = $('.psmRow[value="vel"]').first();
    if (!$velRow.length) return done();
    _set_segment_stage('velocity-enter');
    // Prevent any in-flight updater request from plotting a different velocity product mid-segment.
    try { if (window?.stormTrackData?.current_RadarUpdater) window.stormTrackData.current_RadarUpdater.disable(); } catch (_) {}
    $velRow.trigger('click');

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

    var sawVelocityLoad = false;
    _cleanup_scan_load_listener();
    _scanLoadListener = function (e) {
        if (isStale() || finished) return;
        var detail = e?.detail || {};
        if (_is_storm_relative_product(detail.product)) {
            // Live mode alert velocity segment should only show base velocity.
            $velRow.trigger('click');
            return;
        }
        if (_is_base_velocity_product(detail.product)) {
            sawVelocityLoad = true;
        }
    };
    window.addEventListener('radarBaseFactoryLoaded', _scanLoadListener);

    _trackAlertTimer(function () {
        if (isStale() || finished || sawVelocityLoad) return;
        _set_segment_stage('velocity-fallback');
        _trackAlertTimer(function () {
            finish_once();
        }, 250);
    }, VELOCITY_LOAD_TIMEOUT_MS);

    _set_segment_stage('velocity-hold');
    _trackAlertTimer(function () {
        if (isStale() || finished) return finish_once();
        finish_once();
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

function _score_precipitation(factory) {
    try {
        var symBlock = factory.initial_radar_obj.sym_block;
        if (!symBlock || !symBlock[0] || !symBlock[0][0] || !symBlock[0][0].data) return 0;
        var data = symBlock[0][0].data;
        var mapper = factory.initial_radar_obj.map_data;
        if (!mapper || typeof mapper.__call__ !== 'function') return 0;

        var score = 0;
        for (var r = 0; r < data.length; r += 2) {
            var radial = data[r];
            if (!radial) continue;
            for (var g = 0; g < radial.length; g += 2) {
                var raw = radial[g];
                if (raw < 2) continue;
                var dbz = mapper.__call__(raw);
                if (dbz === null || dbz === undefined) continue;
                if (dbz >= 35) score += 3;
                else if (dbz >= 25) score += 2;
                else if (dbz >= 15) score += 1;
            }
        }
        return score;
    } catch (_) {
        return 0;
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
    var stationScores = [];
    var best = null;
    var bestDate = 0;
    var finalized = false;
    var finalizeTimer = setTimeout(function () {
        _finalize();
    }, 7000);

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
                    if (factory) {
                        var score = _score_precipitation(factory);
                        stationScores.push({ station: station, score: score });
                    }
                    if (checked >= unique.length) _finalize();
                });
            });
        })(unique[i]);
    }

    function _finalize() {
        if (finalized) return;
        finalized = true;
        if (finalizeTimer) {
            clearTimeout(finalizeTimer);
            finalizeTimer = null;
        }
        stationScores.sort(function (a, b) { return b.score - a.score; });
        var MIN_PRECIP_SCORE = 50;
        if (stationScores.length && stationScores[0].score >= MIN_PRECIP_SCORE) {
            callback(stationScores[0].station);
        } else {
            callback(best || _pick_random(unique) || null);
        }
    }

    if (unique.length === 0) _finalize();
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

function _escape_html(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function _truncate_text(value, maxChars) {
    var text = String(value || '').trim();
    if (!text) return '';
    if (text.length <= maxChars) return text;
    return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
}

function _nws_fetch_json(url) {
    var headers = new Headers();
    headers.append('User-Agent', NWS_UA);
    headers.append('Accept', 'application/geo+json');
    return fetch(url, { headers: headers, cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('NWS ' + r.status);
        return r.json();
    });
}

function _get_spotlight_station_coords(station) {
    var loc = nexrad_locations[station] || {};
    var lat = Number(loc.lat || loc.latitude);
    var lon = Number(loc.lon || loc.lng || loc.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat: lat, lon: lon };
}

function _resolve_spotlight_location_name(pointsData, station) {
    var relative = pointsData?.properties?.relativeLocation?.properties || {};
    var city = relative.city || '';
    var state = relative.state || '';
    if (city && state) return city + ', ' + state;

    var stationLoc = nexrad_locations[station] || {};
    return stationLoc.name || station;
}

function _pick_today_forecast_periods(periods) {
    var now = new Date();
    var todayDay = null;
    var todayNight = null;

    for (var i = 0; i < periods.length; i++) {
        var period = periods[i];
        if (!period) continue;
        var start = new Date(period.startTime);
        if (isNaN(start.getTime())) continue;
        if (start.getFullYear() !== now.getFullYear() || start.getMonth() !== now.getMonth() || start.getDate() !== now.getDate()) continue;
        if (period.isDaytime && !todayDay) todayDay = period;
        if (!period.isDaytime && !todayNight) todayNight = period;
        if (todayDay && todayNight) break;
    }

    var fallbackPeriod = periods[0] || null;
    if (!todayDay || !todayNight) {
        for (var j = 0; j < periods.length; j++) {
            var p = periods[j];
            if (!p) continue;
            if (p.isDaytime && !todayDay) todayDay = p;
            if (!p.isDaytime && !todayNight) todayNight = p;
            if (todayDay && todayNight) break;
        }
    }

    return { dayPeriod: todayDay, nightPeriod: todayNight, fallbackPeriod: fallbackPeriod };
}

function _format_temp_text(temp, unit) {
    if (!Number.isFinite(Number(temp))) return 'N/A';
    return String(temp) + '°' + (unit || 'F');
}

function _build_spotlight_forecast_period_html(label, period, options) {
    if (!period) return '';
    options = options || {};

    var tempUnit = period.temperatureUnit || 'F';
    var forecastTemp = _format_temp_text(period.temperature, tempUnit);
    var tempText = forecastTemp;
    if (label === 'Day') {
        tempText = 'High of ' + forecastTemp;
    } else if (label === 'Night') {
        tempText = 'Low of ' + forecastTemp;
    }
    var windParts = [period.windSpeed || '', period.windDirection || ''].join(' ').trim();
    var windText = windParts || 'Wind unavailable';
    var shortForecast = _truncate_text(period.shortForecast || 'Forecast unavailable.', 140);

    var html = '<div class="lmSpotlightForecastPeriod">';
    html += '<div class="lmSpotlightForecastPeriodHeader">' + _escape_html(label) + ' <span>' + _escape_html(tempText) + '</span></div>';
    html += '<div class="lmSpotlightForecastWind">' + _escape_html(windText) + '</div>';
    html += '<div class="lmSpotlightForecastText">' + _escape_html(shortForecast) + '</div>';
    html += '</div>';
    return html;
}

function _format_time_local(isoString, timeZone) {
    if (!isoString) return 'N/A';
    try {
        var date = new Date(isoString);
        if (isNaN(date.getTime())) return 'N/A';
        var opts = { hour: 'numeric', minute: '2-digit' };
        if (timeZone) opts.timeZone = timeZone;
        return new Intl.DateTimeFormat('en-US', opts).format(date);
    } catch (_) {
        return 'N/A';
    }
}

function _get_moon_phase_info() {
    var now = new Date();
    var synodicMonth = 29.53058867;
    var knownNewMoon = Date.UTC(2000, 0, 6, 18, 14, 0);
    var daysSince = (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - knownNewMoon) / 86400000;
    var phase = ((daysSince % synodicMonth) + synodicMonth) % synodicMonth;

    if (phase < 1.84566) return { icon: '🌑', label: 'New Moon' };
    if (phase < 5.53699) return { icon: '🌒', label: 'Waxing Crescent' };
    if (phase < 9.22831) return { icon: '🌓', label: 'First Quarter' };
    if (phase < 12.91963) return { icon: '🌔', label: 'Waxing Gibbous' };
    if (phase < 16.61096) return { icon: '🌕', label: 'Full Moon' };
    if (phase < 20.30228) return { icon: '🌖', label: 'Waning Gibbous' };
    if (phase < 23.99361) return { icon: '🌗', label: 'Last Quarter' };
    if (phase < 27.68493) return { icon: '🌘', label: 'Waning Crescent' };
    return { icon: '🌑', label: 'New Moon' };
}

function _fetch_solar_times(lat, lon) {
    var url = 'https://api.sunrise-sunset.org/json?lat=' + lat + '&lng=' + lon + '&formatted=0';
    return fetch(url, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
            var results = data && data.results ? data.results : null;
            if (!results) return null;
            return {
                sunriseIso: results.sunrise || null,
                sunsetIso: results.sunset || null
            };
        })
        .catch(function () { return null; });
}

function _build_spotlight_risk_summary(alertsData) {
    var features = alertsData?.features || [];
    if (!features.length) {
        return {
            level: 'clear',
            label: 'No active alerts',
            icon: 'fa-solid fa-circle-check',
            message: ''
        };
    }

    var events = [];
    var seen = {};
    for (var i = 0; i < features.length; i++) {
        var eventName = features[i]?.properties?.event;
        if (!eventName || seen[eventName]) continue;
        seen[eventName] = true;
        events.push(eventName);
    }

    var combined = events.join(' | ').toLowerCase();
    var topRisk = 'elevated';
    var label = 'Active alerts nearby';
    if (combined.indexOf('tornado') !== -1 || combined.indexOf('emergency') !== -1) {
        topRisk = 'high';
        label = 'High risk area';
    } else if (combined.indexOf('severe thunderstorm') !== -1 || combined.indexOf('flash flood') !== -1) {
        topRisk = 'elevated';
        label = 'Elevated risk area';
    }

    return {
        level: topRisk,
        label: label,
        icon: topRisk === 'high' ? 'fa-solid fa-triangle-exclamation' : 'fa-solid fa-circle-exclamation',
        message: events.slice(0, 2).join(' | ') + (events.length > 2 ? ' +' + (events.length - 2) + ' more' : '')
    };
}

function _build_spotlight_extra_details_html(summary) {
    var moon = summary.moon || { icon: '🌙', label: 'Moon phase unavailable' };
    var sunrise = summary.sunriseText || 'N/A';
    var sunset = summary.sunsetText || 'N/A';
    var risk = summary.risk || {
        level: 'clear',
        label: 'No active alerts',
        icon: 'fa-solid fa-circle-check',
        message: ''
    };

    var html = '<div class="lmSpotlightForecastDetails">';
    html += '<div class="lmSpotlightForecastDetailRow"><i class="fa-solid fa-sun lmSpotlightForecastIcon"></i><span>Sunrise</span><strong>' + _escape_html(sunrise) + '</strong></div>';
    html += '<div class="lmSpotlightForecastDetailRow"><i class="fa-solid fa-cloud-sun lmSpotlightForecastIcon"></i><span>Sunset</span><strong>' + _escape_html(sunset) + '</strong></div>';
    html += '<div class="lmSpotlightForecastDetailRow"><span class="lmSpotlightForecastMoonIcon">' + _escape_html(moon.icon) + '</span><span>Moon</span><strong>' + _escape_html(moon.label) + '</strong></div>';
    html += '</div>';
    html += '<div class="lmSpotlightForecastRisk lmSpotlightForecastRisk-' + _escape_html(risk.level) + '">';
    html += '<div class="lmSpotlightForecastRiskTitle"><i class="' + _escape_html(risk.icon) + '"></i><span>' + _escape_html(risk.label) + '</span></div>';
    if (risk.message) html += '<div class="lmSpotlightForecastRiskText">' + _escape_html(risk.message) + '</div>';
    html += '</div>';
    return html;
}

function _build_spotlight_forecast_loading_html(station) {
    var html = '<div class="fnAlert lmSpotlightForecastCard" style="--fn-accent:#22d3ee">';
    html += '<div class="fnAlertBody">';
    html += '<div class="fnAlertEventName">TODAY\'S FORECAST</div>';
    html += '<div class="lmSpotlightForecastLoading">Loading local forecast from NWS...</div>';
    html += '</div>';
    html += '</div>';
    return html;
}

function _build_spotlight_forecast_error_html(station) {
    var html = '<div class="fnAlert lmSpotlightForecastCard" style="--fn-accent:#22d3ee">';
    html += '<div class="fnAlertBody">';
    html += '<div class="fnAlertEventName">TODAY\'S FORECAST</div>';
    if (station) html += '<div class="lmSpotlightForecastRegion">' + _escape_html(_resolve_spotlight_location_name({}, station)) + '</div>';
    html += '<div class="lmSpotlightForecastUnavailable">Forecast data is temporarily unavailable for this radar site.</div>';
    html += '</div>';
    html += '</div>';
    return html;
}

function _build_spotlight_forecast_panel_html(station, summary) {
    var dayPeriod = summary.dayPeriod;
    var nightPeriod = summary.nightPeriod;
    var fallbackPeriod = summary.fallbackPeriod;
    var locationName = summary.locationName || station;

    var html = '<div class="fnAlert lmSpotlightForecastCard" style="--fn-accent:#22d3ee">';
    html += '<div class="fnAlertBody">';
    html += '<div class="fnAlertEventName">TODAY\'S FORECAST</div>';
    html += '<div class="lmSpotlightForecastRegion">' + _escape_html(locationName) + '</div>';
    html += '<div class="lmSpotlightForecastPeriods">';
    html += _build_spotlight_forecast_period_html('Day', dayPeriod);
    html += _build_spotlight_forecast_period_html('Night', nightPeriod);
    if (!dayPeriod && !nightPeriod) {
        html += _build_spotlight_forecast_period_html((fallbackPeriod && fallbackPeriod.name) || 'Latest', fallbackPeriod);
    }
    html += '</div>';
    html += _build_spotlight_extra_details_html(summary);
    html += '</div>';
    html += '</div>';
    return html;
}

function _with_timeout(promise, timeoutMs) {
    return Promise.race([
        promise,
        new Promise(function (_, reject) {
            setTimeout(function () { reject(new Error('timeout')); }, timeoutMs);
        })
    ]);
}

function _fetch_nws_json_with_retry(url, timeoutMs, retries) {
    var attempts = 0;
    function attempt() {
        attempts++;
        return _with_timeout(_nws_fetch_json(url), timeoutMs).catch(function (err) {
            if (attempts > retries) throw err;
            return attempt();
        });
    }
    return attempt();
}

function _get_cached_spotlight_forecast_html(station) {
    var entry = _spotlightForecastCache[station];
    if (!entry) return null;
    if ((Date.now() - entry.ts) > SPOTLIGHT_FORECAST_CACHE_TTL_MS) {
        delete _spotlightForecastCache[station];
        return null;
    }
    return entry.html || null;
}

function _set_cached_spotlight_forecast_html(station, html) {
    _spotlightForecastCache[station] = {
        ts: Date.now(),
        html: html
    };
}

function _load_spotlight_forecast_panel(station, segmentEpoch, onReady) {
    if (typeof onReady !== 'function') onReady = function () {};
    var requestEpoch = ++_spotlightForecastRequestEpoch;
    var coords = _get_spotlight_station_coords(station);
    if (!coords) {
        onReady(_build_spotlight_forecast_error_html(station));
        return;
    }

    var cachedHtml = _get_cached_spotlight_forecast_html(station);
    if (cachedHtml) {
        onReady(cachedHtml);
        return;
    }

    var lat = coords.lat.toFixed(4);
    var lon = coords.lon.toFixed(4);
    var pointsUrl = 'https://api.weather.gov/points/' + lat + ',' + lon;

    function isStale() {
        return !_active ||
            _currentSegmentType !== 'spotlight' ||
            segmentEpoch !== _alertEpoch ||
            requestEpoch !== _spotlightForecastRequestEpoch;
    }

    _fetch_nws_json_with_retry(pointsUrl, 6500, 1)
        .then(function (pointsData) {
            if (isStale()) return null;
            var forecastUrl = pointsData?.properties?.forecast;
            var alertsUrl = 'https://api.weather.gov/alerts/active?point=' + lat + ',' + lon;
            if (!forecastUrl) throw new Error('Missing forecast URL');
            return Promise.all([
                _fetch_nws_json_with_retry(forecastUrl, 6500, 1),
                _with_timeout(_nws_fetch_json(alertsUrl), 1600).catch(function () { return { features: [] }; }),
                _with_timeout(_fetch_solar_times(lat, lon), 1400).catch(function () { return null; })
            ]).then(function (results) {
                return {
                    pointsData: pointsData,
                    forecastData: results[0],
                    alertsData: results[1],
                    solarData: results[2]
                };
            });
        })
        .then(function (result) {
            if (!result || isStale()) return;
            var periods = result.forecastData?.properties?.periods || [];
            var picked = _pick_today_forecast_periods(periods);
            var timeZone = result.pointsData?.properties?.timeZone || '';
            var moon = _get_moon_phase_info();
            var summary = {
                locationName: _resolve_spotlight_location_name(result.pointsData, station),
                dayPeriod: picked.dayPeriod,
                nightPeriod: picked.nightPeriod,
                fallbackPeriod: picked.fallbackPeriod,
                sunriseText: _format_time_local(result.solarData?.sunriseIso, timeZone),
                sunsetText: _format_time_local(result.solarData?.sunsetIso, timeZone),
                moon: moon,
                risk: _build_spotlight_risk_summary(result.alertsData)
            };
            var html = _build_spotlight_forecast_panel_html(station, summary);
            _set_cached_spotlight_forecast_html(station, html);
            onReady(html);
        })
        .catch(function () {
            if (isStale()) return;
            var staleHtml = _spotlightForecastCache[station]?.html || null;
            onReady(staleHtml || _build_spotlight_forecast_error_html(station));
        });
}

function _run_spotlight_segment(resolve) {
    _currentSegmentType = 'spotlight';
    _set_segment_stage('enter');

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
        _set_segment_stage('finish');
        _cancelAllAlertTimers();
        _clear_segment_timer();
        _cleanup_loop_listener();
        _stop_typewriter();
        _hide_info_panel();
        _hide_spotlight_forecast_panel();
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
        _set_segment_stage('station');

        _record_segment('spotlight', station);

        _ensure_single_site_mode();
        _reset_to_reflectivity();

        controller = window.stormTrackData?.radarLoopController;
        var isSameStation = window.stormTrackData.currentStation === station;
        if (controller) {
            controller.state.frameCount = PLAYBACK_FRAME_COUNT;
            controller.state.speedMultiplier = PLAYBACK_SPEED;
        }
        station_markers.selectStation(station, nexrad_locations[station].type || 'WSR-88D', { persist: false });
        _show_radar_render();
        _show_station_markers();
        _show_alert_polygons();
        _show_radar_sweep();
        _show_lightning_overlay();
        _show_header_radar_info({ force: true });
        if (isSameStation && controller && controller.state.active && controller.state.supported) {
            controller.refresh_frames();
        }

        var forecastPanelHtml = null;
        var forecastPanelReady = false;
        var forecastPanelVisible = false;
        var revealTriggered = false;
        var loadingRevealTimer = null;
        function revealForecastPanel() {
            if (revealTriggered) return;
            revealTriggered = true;
            forecastPanelVisible = true;
            if (forecastPanelReady && forecastPanelHtml) {
                _show_spotlight_forecast_panel(forecastPanelHtml);
            } else {
                loadingRevealTimer = setTimeout(function () {
                    loadingRevealTimer = null;
                    if (forecastPanelVisible && !isStale() && !forecastPanelReady) {
                        _show_spotlight_forecast_panel(_build_spotlight_forecast_loading_html(station));
                    }
                }, 650);
            }
        }
        _load_spotlight_forecast_panel(station, epoch, function (html) {
            if (isStale()) return;
            _set_segment_stage('forecast-ready');
            forecastPanelReady = true;
            forecastPanelHtml = html;
            if (loadingRevealTimer) {
                clearTimeout(loadingRevealTimer);
                loadingRevealTimer = null;
            }
            if (forecastPanelVisible && forecastPanelHtml) {
                _show_spotlight_forecast_panel(forecastPanelHtml, { animate: false });
            }
        });

        var loc = nexrad_locations[station];
        try {
            map.once('moveend', function () {
                _trackAlertTimer(revealForecastPanel, 250);
            });
        } catch (_) {}
        map.flyTo({
            center: [loc.lon, loc.lat],
            zoom: 7,
            speed: 1.2,
            essential: true
        });
        _trackAlertTimer(revealForecastPanel, 1700);

        _show_info_panel(_build_spotlight_panel_html(station));

        _trackAlertTimer(function () {
            if (isStale()) return finish();
            _set_segment_stage('playback');
            _run_playback(epoch, function () {
                if (isStale()) return finish();
                _set_segment_stage('wait-text');
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

    var requestedOpacity = arguments.length > 0 ? arguments[0] : null;
    var opacity = 0.85;
    if (window.stormTrackData?.radarOpacity != null) opacity = window.stormTrackData.radarOpacity;
    if (typeof requestedOpacity === 'number') opacity = Math.max(0, Math.min(1, requestedOpacity));

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
            'raster-fade-duration': 250
        }
    }, beforeLayer);
}

function _set_static_mrms_opacity(opacity) {
    if (!map || !map.getLayer(CONUS_MRMS_LAYER)) return;
    var clampedOpacity = Math.max(0, Math.min(1, opacity));
    map.setPaintProperty(CONUS_MRMS_LAYER, 'raster-opacity', clampedOpacity);
}

function _get_static_mrms_target_opacity() {
    var opacity = 0.85;
    if (window.stormTrackData?.radarOpacity != null) opacity = window.stormTrackData.radarOpacity;
    return Math.max(0, Math.min(1, opacity));
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
    _set_segment_stage('enter');
    _record_segment('conus', 'conus');
    _set_clock_mode('hidden');
    _hide_header_radar_info(null);
    _show_info_panel(_build_conus_panel_html());

    _ensure_single_site_mode();
    _hide_radar_render();
    _hide_station_markers();
    _hide_alert_polygons();
    _hide_radar_sweep();
    _hide_lightning_overlay();
    _clear_active_station_selection();
    var conusTargetOpacity = _get_static_mrms_target_opacity();
    _add_static_mrms_layer(0);
    map.flyTo({ center: CONUS_CENTER, zoom: CONUS_ZOOM, speed: 1.2, essential: true });
    function reveal_mrms_layer() {
        if (!_active || _currentSegmentType !== 'conus') return;
        try { map.off('idle', reveal_mrms_layer); } catch (_) {}
        _set_static_mrms_opacity(conusTargetOpacity);
    }
    map.once('idle', reveal_mrms_layer);
    setTimeout(reveal_mrms_layer, CONUS_MRMS_REVEAL_TIMEOUT_MS);
    if (Math.random() > 0.35) {
        _typewrite(_generate_conus_commentary(), 1200);
    }

    var focusRegions = _shuffle_array_copy(CONUS_SEVERE_FOCUS_REGIONS).slice(0, CONUS_REGION_FOCUS_COUNT);
    var overviewDwellMs = Math.round(CONUS_SEGMENT_DURATION_MS * CONUS_OVERVIEW_SHARE);
    var regionBudgetMs = Math.max(0, CONUS_SEGMENT_DURATION_MS - overviewDwellMs);

    if (focusRegions.length) {
        var maxRegionCount = Math.max(1, Math.floor(regionBudgetMs / CONUS_REGION_MIN_DWELL_MS));
        if (maxRegionCount < focusRegions.length) {
            focusRegions = focusRegions.slice(0, maxRegionCount);
        }
    }

    var regionDwellMs = focusRegions.length
        ? Math.max(CONUS_REGION_MIN_DWELL_MS, Math.floor(regionBudgetMs / focusRegions.length))
        : 0;
    if (!focusRegions.length) overviewDwellMs = CONUS_SEGMENT_DURATION_MS;

    var didResolve = false;
    function finish() {
        if (didResolve) return;
        didResolve = true;
        _set_segment_stage('wait-text');
        _wait_for_typewriter_then(function () {
            _set_segment_stage('finish');
            _stop_typewriter();
            _hide_info_panel();
            _remove_static_mrms_layer();
            _show_header_radar_info();
            resolve();
        });
    }

    var focusIdx = 0;
    function run_next_focus() {
        if (!_active || _currentSegmentType !== 'conus') return;
        if (focusIdx >= focusRegions.length) return finish();
        _set_segment_stage('focus');

        var region = focusRegions[focusIdx++];
        _show_info_panel(_build_conus_panel_html(region.name));
        map.flyTo({
            center: region.center,
            zoom: region.zoom + CONUS_REGION_EXTRA_ZOOM,
            speed: 1.05,
            essential: true
        });

        _segmentTimer = setTimeout(run_next_focus, regionDwellMs);
    }

    _segmentTimer = setTimeout(function () {
        if (!_active || _currentSegmentType !== 'conus') return;
        if (!focusRegions.length) return finish();
        run_next_focus();
    }, overviewDwellMs);
}

// ── Current Conditions Segment ───────────────────────────────────────────────

const CONDITIONS_DURATION_MS = 15000;
const LM_CONDITIONS_SOURCE = 'lmConditionsSource';
const LM_CONDITIONS_CIRCLE = 'lmConditionsCircle';
const LM_CONDITIONS_LABEL = 'lmConditionsLabel';
const CONDITIONS_BUBBLE_REVEAL_SPAN_MIN_MS = 500;
const CONDITIONS_BUBBLE_REVEAL_SPAN_MAX_MS = 900;
const CONDITIONS_BUBBLE_REVEAL_PER_BUBBLE_MS = 55;
const CONDITIONS_BUBBLE_REVEAL_FLY_FALLBACK_MS = 1100;
const CONDITIONS_BUBBLE_REVEAL_FADE_MS = 320;

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

function _get_region_stations(region) {
    if (!region || !Array.isArray(region.cities)) return [];
    var stations = [];
    for (var i = 0; i < region.cities.length; i++) {
        var station = region.cities[i] && region.cities[i].station;
        if (!station) continue;
        if (stations.indexOf(station) !== -1) continue;
        stations.push(station);
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

function _fetch_observations(stations, callback) {
    var unique = Array.isArray(stations) ? stations.filter(function (s, i) { return stations.indexOf(s) === i; }) : [];
    if (!unique.length) return callback({});
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

function _shuffle_array_copy(list) {
    var copy = list.slice();
    for (var i = copy.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = copy[i];
        copy[i] = copy[j];
        copy[j] = tmp;
    }
    return copy;
}

function _set_conditions_source_features(features) {
    var source = map.getSource(LM_CONDITIONS_SOURCE);
    if (!source) return;
    source.setData(turf.featureCollection(features));
}

function _build_conditions_features(region, observations) {
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
        var feature = turf.point([city.lng, city.lat], {
            name: city.name,
            tempLabel: tempLabel,
            feelsLabel: feelsLabel,
            tempF: ob.tempF,
            feelsLike: feelsLike,
            color: bgColor,
            textColor: colors[1],
            bubbleOpacity: 0,
            bubbleStrokeOpacity: 0,
            tempTextOpacity: 0,
            cityTextOpacity: 0,
            feelsTextOpacity: 0
        });
        feature.id = city.station || (city.name + '-' + i);
        features.push(feature);
    }
    return features;
}

function _add_conditions_layer(features) {
    _remove_conditions_layer();
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
            'circle-opacity': ['get', 'bubbleOpacity'],
            'circle-opacity-transition': { duration: CONDITIONS_BUBBLE_REVEAL_FADE_MS, delay: 0 },
            'circle-stroke-width': 2,
            'circle-stroke-color': 'rgba(255,255,255,0.5)',
            'circle-stroke-opacity': ['get', 'bubbleStrokeOpacity'],
            'circle-stroke-opacity-transition': { duration: CONDITIONS_BUBBLE_REVEAL_FADE_MS, delay: 0 }
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
            'text-halo-width': 1.5,
            'text-opacity': ['get', 'tempTextOpacity'],
            'text-opacity-transition': { duration: CONDITIONS_BUBBLE_REVEAL_FADE_MS, delay: 0 }
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
            'text-halo-width': 1.5,
            'text-opacity': ['get', 'cityTextOpacity'],
            'text-opacity-transition': { duration: CONDITIONS_BUBBLE_REVEAL_FADE_MS, delay: 0 }
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
            'text-halo-width': 1.2,
            'text-opacity': ['get', 'feelsTextOpacity'],
            'text-opacity-transition': { duration: CONDITIONS_BUBBLE_REVEAL_FADE_MS, delay: 0 }
        }
    });

    return {
        featureCount: features.length,
        startReveal: function () {
            if (!Array.isArray(features) || !features.length) {
                _set_conditions_source_features([]);
                return;
            }
            var revealOrder = _shuffle_array_copy(features);
            var revealWindowMs = Math.max(
                CONDITIONS_BUBBLE_REVEAL_SPAN_MIN_MS,
                Math.min(CONDITIONS_BUBBLE_REVEAL_SPAN_MAX_MS, revealOrder.length * CONDITIONS_BUBBLE_REVEAL_PER_BUBBLE_MS)
            );
            var scheduled = revealOrder.map(function (feature, idx) {
                return {
                    feature: feature,
                    delayMs: idx === 0 ? 0 : Math.floor(Math.random() * revealWindowMs)
                };
            }).sort(function (a, b) {
                return a.delayMs - b.delayMs;
            });

            for (var r = 0; r < revealOrder.length; r++) {
                var resetProps = revealOrder[r].properties || {};
                resetProps.bubbleOpacity = 0;
                resetProps.bubbleStrokeOpacity = 0;
                resetProps.tempTextOpacity = 0;
                resetProps.cityTextOpacity = 0;
                resetProps.feelsTextOpacity = 0;
            }
            _set_conditions_source_features(features);
            for (var i = 0; i < scheduled.length; i++) {
                (function (entry) {
                    _trackAlertTimer(function () {
                        if (!_active) return;
                        if (!map.getSource(LM_CONDITIONS_SOURCE)) return;
                        var props = entry.feature.properties || {};
                        props.bubbleOpacity = 0.88;
                        props.bubbleStrokeOpacity = 1;
                        props.tempTextOpacity = 1;
                        props.cityTextOpacity = 0.95;
                        props.feelsTextOpacity = 0.75;
                        _set_conditions_source_features(features);
                    }, entry.delayMs);
                })(scheduled[i]);
            }
        }
    };
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

function _fetch_text_with_proxy_fallback(url) {
    return _fetch_text_meta_with_proxy_fallback(url).then(function (meta) { return meta.text; });
}

function _fetch_text_meta_with_proxy_fallback(url) {
    return fetch(url, { cache: 'no-store' })
        .then(function (r) {
            if (!r.ok) throw new Error('Fetch failed: ' + r.status);
            return r.text().then(function (text) {
                return { text: text, lastModified: r.headers.get('last-modified') || '' };
            });
        })
        .catch(function () {
            var proxyPrefix = (ut && ut.phpProxy) ? ut.phpProxy : SPC_REPORTS_PROXY_PREFIX;
            return fetch(proxyPrefix + encodeURIComponent(url), { cache: 'no-store' })
                .then(function (r) {
                    if (!r.ok) throw new Error('Proxy fetch failed: ' + r.status);
                    return r.text().then(function (text) {
                        return { text: text, lastModified: r.headers.get('last-modified') || '' };
                    });
                });
        });
}

function _parse_csv_line(line) {
    var out = [];
    var cell = '';
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                cell += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (ch === ',' && !inQuotes) {
            out.push(cell);
            cell = '';
        } else {
            cell += ch;
        }
    }
    out.push(cell);
    return out;
}

function _parse_csv_text(text) {
    var lines = String(text || '')
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .filter(function (line) { return line && line.trim().length > 0; });
    if (!lines.length) return { headers: [], rows: [] };
    var headers = _parse_csv_line(lines[0]).map(function (h) { return String(h || '').trim(); });
    var rows = [];
    for (var i = 1; i < lines.length; i++) {
        rows.push(_parse_csv_line(lines[i]));
    }
    return { headers: headers, rows: rows };
}

function _extract_spc_today_csv_urls(htmlText) {
    var html = String(htmlText || '');
    var keys = ['tornado', 'hail', 'wind'];
    var fileNames = { tornado: 'today_torn.csv', hail: 'today_hail.csv', wind: 'today_wind.csv' };
    var out = {
        tornado: SPC_TODAY_REPORT_CSV_DEFAULT_URLS.tornado,
        hail: SPC_TODAY_REPORT_CSV_DEFAULT_URLS.hail,
        wind: SPC_TODAY_REPORT_CSV_DEFAULT_URLS.wind
    };
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var rx = new RegExp('(https?:\\/\\/www\\.spc\\.noaa\\.gov\\/climo\\/reports\\/' + fileNames[key] + '|\\/climo\\/reports\\/' + fileNames[key] + ')', 'i');
        var match = html.match(rx);
        if (!match || !match[1]) continue;
        out[key] = match[1].indexOf('/climo/') === 0 ? ('https://www.spc.noaa.gov' + match[1]) : match[1];
    }
    return out;
}

function _extract_spc_last_update_text(htmlText) {
    var html = String(htmlText || '');
    var patterns = [
        /Map\s+updated\s+at\s+[0-9]{3,4}\s*Z?\s+on\s+\d{1,2}\/\d{1,2}\/\d{2,4}/i,
        /Map\s+updated\s+at\s+[^\r\n<]+/i,
        /updated\s+at\s+[0-9]{3,4}\s*Z?\s+on\s+\d{1,2}\/\d{1,2}\/\d{2,4}/i
    ];
    for (var i = 0; i < patterns.length; i++) {
        var match = html.match(patterns[i]);
        if (match && match[0]) return match[0].replace(/\s+/g, ' ').trim();
    }
    return '';
}

function _format_last_modified_header(lastModified) {
    var raw = String(lastModified || '').trim();
    if (!raw) return '';
    var d = new Date(raw);
    if (!Number.isFinite(d.getTime())) return raw;
    var datePart = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        month: 'short',
        day: 'numeric',
        year: 'numeric'
    }).format(d);
    var timePart = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    }).format(d);
    return 'Map updated at ' + timePart + ' UTC on ' + datePart;
}

function _parse_spc_lat(raw) {
    var num = Number(raw);
    if (!Number.isFinite(num)) return null;
    if (Math.abs(num) > 90) num = num / 100;
    if (!Number.isFinite(num) || Math.abs(num) > 90) return null;
    return num;
}

function _parse_spc_lon(raw) {
    var num = Number(raw);
    if (!Number.isFinite(num)) return null;
    if (Math.abs(num) > 180) num = num / 100;
    if (num > 0) num = -num;
    if (!Number.isFinite(num) || Math.abs(num) > 180) return null;
    return num;
}

function _spc_report_color(category) {
    if (category === 'tornado') return '#ff3232';
    if (category === 'hail') return '#00d14f';
    return '#2f8cff';
}

function _parse_spc_report_csv(text, category) {
    var parsed = _parse_csv_text(text);
    var headers = parsed.headers;
    var rows = parsed.rows;
    if (!headers.length || !rows.length) return [];
    var out = [];
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (!row || !row.length) continue;
        var obj = {};
        for (var c = 0; c < headers.length; c++) {
            obj[headers[c]] = row[c] != null ? String(row[c]).trim() : '';
        }
        var lat = _parse_spc_lat(obj.Lat);
        var lon = _parse_spc_lon(obj.Lon);
        if (lat == null || lon == null) continue;
        var speed = Number(obj.Speed);
        var size = Number(obj.Size);
        var sig = 0;
        if (category === 'hail' && Number.isFinite(size)) sig = size >= 200 ? 1 : 0;
        else if (category === 'wind' && Number.isFinite(speed)) sig = speed >= 65 ? 1 : 0;
        out.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: {
                category: category,
                color: _spc_report_color(category),
                sig: sig,
                state: String(obj.State || '').toUpperCase(),
                location: obj.Location || '',
                time: obj.Time || ''
            }
        });
    }
    return out;
}

function _fetch_spc_today_report_summary() {
    return _fetch_text_meta_with_proxy_fallback(SPC_TODAY_REPORTS_URL).then(function (pageMeta) {
        var html = pageMeta.text || '';
        var urls = _extract_spc_today_csv_urls(html);
        var lastUpdateText = _extract_spc_last_update_text(html) || _format_last_modified_header(pageMeta.lastModified);
        function _fetchCat(name, url) {
            return _fetch_text_with_proxy_fallback(url)
                .then(function (csvText) { return _parse_spc_report_csv(csvText, name); })
                .catch(function () { return []; });
        }
        return Promise.all([
            _fetchCat('tornado', urls.tornado),
            _fetchCat('hail', urls.hail),
            _fetchCat('wind', urls.wind)
        ]).then(function (parts) {
            var tornado = parts[0] || [];
            var hail = parts[1] || [];
            var wind = parts[2] || [];
            return {
                sourceUrl: SPC_TODAY_REPORTS_URL,
                lastUpdateText: lastUpdateText,
                tornadoCount: tornado.length,
                hailCount: hail.length,
                windCount: wind.length,
                features: tornado.concat(hail, wind)
            };
        });
    });
}

function _add_live_storm_reports_layer(summary) {
    _remove_live_storm_reports_layer();
    var fc = {
        type: 'FeatureCollection',
        features: Array.isArray(summary?.features) ? summary.features : []
    };
    map.addSource(LM_STORM_REPORTS_SOURCE, { type: 'geojson', data: fc });

    map.addLayer({
        id: LM_STORM_REPORTS_LAYER,
        type: 'circle',
        source: LM_STORM_REPORTS_SOURCE,
        paint: {
            'circle-radius': 3.5,
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.9,
            'circle-stroke-width': 0
        }
    });

    map.addLayer({
        id: LM_STORM_REPORTS_SIG_LAYER,
        type: 'circle',
        source: LM_STORM_REPORTS_SOURCE,
        filter: ['==', ['get', 'sig'], 1],
        paint: {
            'circle-radius': 5.5,
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.95,
            'circle-stroke-width': 0
        }
    });
}

function _remove_live_storm_reports_layer() {
    try { if (map.getLayer(LM_STORM_REPORTS_SIG_LAYER)) map.removeLayer(LM_STORM_REPORTS_SIG_LAYER); } catch (_) {}
    try { if (map.getLayer(LM_STORM_REPORTS_LAYER)) map.removeLayer(LM_STORM_REPORTS_LAYER); } catch (_) {}
    try { if (map.getSource(LM_STORM_REPORTS_SOURCE)) map.removeSource(LM_STORM_REPORTS_SOURCE); } catch (_) {}
}

function _focus_storm_reports_map(summary) {
    var features = Array.isArray(summary?.features) ? summary.features : [];
    if (!features.length) {
        try {
            map.flyTo({ center: CONUS_CENTER, zoom: CONUS_ZOOM, speed: 1.05, essential: true });
        } catch (_) {}
        return;
    }

    var fc = {
        type: 'FeatureCollection',
        features: features
    };
    try {
        var bbox = turf.bbox(fc);
        if (!bbox || bbox.length !== 4) throw new Error('invalid bbox');
        map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], {
            padding: { top: 90, right: 60, bottom: 110, left: 300 },
            maxZoom: 6.1,
            speed: 0.95,
            essential: true
        });
    } catch (_) {
        try {
            map.flyTo({ center: CONUS_CENTER, zoom: CONUS_ZOOM, speed: 1.05, essential: true });
        } catch (_) {}
    }
}

function _build_storm_reports_panel_html(summary) {
    var tornadoCount = summary?.tornadoCount || 0;
    var hailCount = summary?.hailCount || 0;
    var windCount = summary?.windCount || 0;
    var total = tornadoCount + hailCount + windCount;
    var html = '<div class="fnAlert" style="--fn-accent:#fb7185">';
    html += '<div class="fnAlertShine"></div>';
    html += '<div class="fnAlertBody">';
    html += '<div class="fnAlertEventName">SPC STORM REPORTS</div>';
    html += '<div class="fnAlertSourceLine" style="margin-top:4px;opacity:0.8">' + total + ' report' + (total !== 1 ? 's' : '') + '</div>';
    html += '<div class="fnAlertSourceLine" style="margin-top:2px;opacity:0.65">Source: <a href="' + _escape_html(SPC_TODAY_REPORTS_URL) + '" target="_blank" rel="noopener noreferrer" style="color:#ffd9e2;text-decoration:underline;">spc.noaa.gov/climo/reports/today.html</a></div>';
    html += '</div></div>';
    html += '<div style="margin-top:10px;padding:12px 14px;border-radius:12px;background:rgba(8,12,20,0.55);border:1px solid rgba(255,255,255,0.12);font-size:14px;line-height:1.42;">';
    html += '<span style="color:#ff3232;font-weight:700;">TORNADO</span>: ' + tornadoCount + '&nbsp;&nbsp;·&nbsp;&nbsp;';
    html += '<span style="color:#00d14f;font-weight:700;">HAIL</span>: ' + hailCount + '&nbsp;&nbsp;·&nbsp;&nbsp;';
    html += '<span style="color:#2f8cff;font-weight:700;">WIND</span>: ' + windCount;
    html += '<div style="margin-top:6px;opacity:0.75;">Larger dots indicate significant hail (2"+) or wind (65+ mph).</div>';
    html += '</div>';
    return html;
}

function _run_storm_reports_segment(resolve) {
    _currentSegmentType = 'storm_reports';
    _set_segment_stage('enter');
    _record_segment('storm_reports', 'spc-reports-map');
    _set_clock_mode('hidden');
    _hide_header_radar_info(null);

    _hide_all_map_overlays();
    _clear_active_station_selection();
    _remove_static_mrms_layer();
    _remove_conditions_layer();
    _remove_earthquake_layer();
    _hide_storm_reports();

    function _cleanup() {
        _set_segment_stage('finish');
        _stop_typewriter();
        _remove_live_storm_reports_layer();
        _show_header_radar_info();
        _hide_info_panel();
        resolve();
    }

    _set_segment_stage('fetch');
    _fetch_spc_today_report_summary().then(function (summary) {
        if (!_active) return _cleanup();
        _set_segment_stage('render');
        _add_live_storm_reports_layer(summary);
        _focus_storm_reports_map(summary);
        _show_info_panel(_build_storm_reports_panel_html(summary));
        _segmentTimer = setTimeout(function () {
            _cleanup();
        }, STORM_REPORTS_SEGMENT_DURATION_MS);
    }).catch(function () {
        if (!_active) return _cleanup();
        _set_segment_stage('render-fallback');
        _remove_live_storm_reports_layer();
        _focus_storm_reports_map({ features: [] });
        _show_info_panel(_build_storm_reports_panel_html({ tornadoCount: 0, hailCount: 0, windCount: 0, features: [], lastUpdateText: '' }));
        _segmentTimer = setTimeout(function () {
            _cleanup();
        }, STORM_REPORTS_SEGMENT_DURATION_MS);
    });
}

var _lastConditionsRegionIdx = -1;

function _run_conditions_segment(resolve) {
    _currentSegmentType = 'conditions';
    _set_segment_stage('enter');
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
    _clear_active_station_selection();
    _remove_static_mrms_layer();
    _show_info_panel(_build_conditions_panel_html(region.name));

    var conditionsFlyComplete = false;
    var conditionsLayerReady = false;
    var conditionsRevealStarted = false;
    var conditionsLayerController = null;
    function _start_conditions_reveal_when_ready() {
        if (conditionsRevealStarted) return;
        if (!conditionsFlyComplete || !conditionsLayerReady || !conditionsLayerController) return;
        conditionsRevealStarted = true;
        conditionsLayerController.startReveal();
    }

    try {
        map.once('moveend', function () {
            conditionsFlyComplete = true;
            _start_conditions_reveal_when_ready();
        });
    } catch (_) {
        conditionsFlyComplete = true;
    }

    map.flyTo({ center: region.center, zoom: region.zoom, speed: 1.2, essential: true });
    _trackAlertTimer(function () {
        if (conditionsFlyComplete) return;
        conditionsFlyComplete = true;
        _start_conditions_reveal_when_ready();
    }, CONDITIONS_BUBBLE_REVEAL_FLY_FALLBACK_MS);

    _fetch_observations(_get_region_stations(region), function (observations) {
        if (!_active) { _show_header_radar_info(); _hide_cond_legend(); return resolve(); }
        _set_segment_stage('obs-ready');

        var obsKeys = Object.keys(observations);
        if (obsKeys.length === 0) {
            console.warn('[LiveMode] Conditions segment: no observation data returned');
            _show_header_radar_info();
            _hide_cond_legend();
            _hide_info_panel();
            return resolve();
        }

        _trackAlertTimer(function () {
            if (!_active) { _show_header_radar_info(); _hide_cond_legend(); return resolve(); }
            _set_segment_stage('plot');
            var features = _build_conditions_features(region, observations);
            conditionsLayerController = _add_conditions_layer(features);
            _show_cond_legend();
            conditionsLayerReady = true;
            _start_conditions_reveal_when_ready();

            _segmentTimer = setTimeout(function () {
                _set_segment_stage('finish');
                _remove_conditions_layer();
                _hide_cond_legend();
                _show_header_radar_info();
                _hide_info_panel();
                resolve();
            }, CONDITIONS_DURATION_MS);
        }, 80);
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

function _to_miles(km) {
    return Math.max(1, Math.round(km * 0.621371));
}

function _format_quake_place_miles(place) {
    if (!place) return place;
    // USGS often reports locations like "59 km SSW of Whites City, New Mexico".
    return String(place).replace(/\b(\d+(?:\.\d+)?)\s*km\b/gi, function (_, kmText) {
        var km = parseFloat(kmText);
        if (isNaN(km)) return _;
        return _to_miles(km) + ' mi';
    });
}

function _generate_earthquake_commentary(quakes) {
    var tod = _time_of_day();

    if (quakes.length === 0) {
        return _pick_random([
            'No significant earthquakes across the lower 48 in the last 24 hours.',
            'The USGS reports no M2.5+ earthquakes within the lower 48 over the past day. Quiet day seismically.',
            'The seismographs have been quiet ' + tod + '. No noteworthy earthquake activity to report.',
            'All quiet underground. No M2.5+ events in the contiguous U.S. over the past day.'
        ]);
    }

    var lines = [];
    lines.push(_pick_random([
        'Here\'s the latest earthquake activity from the USGS over the past 24 hours.',
        'Let\'s check in on recent seismic activity across the U.S.',
        'Time to check the seismographs. Here\'s what\'s been shaking across the lower 48.'
    ]));

    var strongest = quakes[0];
    for (var i = 1; i < quakes.length; i++) {
        if (quakes[i].properties.mag > strongest.properties.mag) strongest = quakes[i];
    }

    var sMag = strongest.properties.mag;
    var sPlace = _format_quake_place_miles(strongest.properties.place || 'an unknown location');

    if (sMag >= 4.5) {
        lines.push(_pick_random([
            'The biggest event is a magnitude ' + sMag.toFixed(1) + ' near ' + sPlace + '. Strong enough to be widely felt and could cause minor damage.',
            'A notable M' + sMag.toFixed(1) + ' was recorded near ' + sPlace + '. That\'s a significant shake.',
            'We\'re looking at a magnitude ' + sMag.toFixed(1) + ' near ' + sPlace + '. Shaking would have been felt over a wide area.'
        ]));
    } else if (sMag >= 3.5) {
        lines.push(_pick_random([
            'The largest event was an M' + sMag.toFixed(1) + ' near ' + sPlace + '. Likely felt nearby but unlikely to cause damage.',
            'An M' + sMag.toFixed(1) + ' was recorded near ' + sPlace + '. People close to the epicenter probably felt a jolt.',
            'We saw a magnitude ' + sMag.toFixed(1) + ' near ' + sPlace + '. Enough to rattle windows if you were nearby.'
        ]));
    } else {
        lines.push(_pick_random([
            'The strongest was an M' + sMag.toFixed(1) + ' near ' + sPlace + '. Minor activity, generally not felt.',
            'An M' + sMag.toFixed(1) + ' near ' + sPlace + ' leads the list. Small magnitude, mostly picked up by instruments.',
            'The largest event is an M' + sMag.toFixed(1) + ' near ' + sPlace + '. Too small for most people to notice.'
        ]));
    }

    if (quakes.length > 1) {
        lines.push(quakes.length + ' total events at M2.5 or greater across the lower 48 in the past day.');
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
        html += '<div class="fnAlertSourceLine" style="margin-top:2px;opacity:0.6;color:#ffd84d">Strongest: M' + maxMag.toFixed(1) + '</div>';
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

function _build_spc_legend_html(geojson, hazard) {
    var features = (geojson && geojson.features) || [];
    var seen = {};
    var items = [];
    for (var i = 0; i < features.length; i++) {
        var p = features[i].properties || {};
        var label = String(p.label || '').toUpperCase();
        var label2 = String(p.label2 || '').toUpperCase();
        if (label === 'TSTM' || label2.indexOf('GENERAL THUNDER') !== -1) continue;
        var isHatched = _is_hatched_feature(p);
        var isCig = _is_cig_feature(p);
        var fill = p.fill || '#8dc6ff';
        var stroke = p.stroke || '#59a9ff';
        var cigLevel = isCig ? _get_cig_level(p) : 0;
        var rawLabel = isCig ? _format_cig_label(p, hazard) : (p.label2 || p.label || 'Risk');
        var displayLabel = _simplify_spc_legend_label(rawLabel, hazard, isCig);
        var key = fill + '|' + stroke + '|' + (isHatched ? 1 : 0) + '|' + (isCig ? 1 : 0) + '|' + cigLevel;
        if (seen[key]) continue;
        seen[key] = true;
        items.push({
            label: displayLabel,
            rawLabel: rawLabel,
            fill: fill,
            stroke: stroke,
            isHatched: isHatched,
            isCig: isCig,
            cigLevel: cigLevel
        });
    }
    if (!items.length) return '';
    items.sort(function (a, b) {
        var rankDiff = _spc_legend_rank(b) - _spc_legend_rank(a);
        if (rankDiff !== 0) return rankDiff;
        if (a.isHatched !== b.isHatched) return a.isHatched ? 1 : -1;
        return String(a.label).localeCompare(String(b.label));
    });
    var html = '';
    for (var j = 0; j < items.length; j++) {
        var item = items[j];
        var style;
        if (item.isCig) {
            style = 'background:#ffffff;border-color:#ffffff;';
        } else if (item.isHatched) {
            style = 'background:transparent;border-color:' + item.stroke + ';color:' + item.stroke + ';';
        } else {
            style = 'background:' + item.fill + ';border-color:' + item.stroke + ';';
        }
        var extraClass = '';
        if (item.isCig) extraClass = ' lmSpcLegendSwatch-cig' + item.cigLevel;
        else if (item.isHatched) extraClass = ' lmSpcLegendSwatch-hatched';
        html += '<div class="lmSpcLegendRow">';
        html += '<span class="lmSpcLegendSwatch' + extraClass + '" style="' + style + '"></span>';
        html += ' ' + item.label;
        html += '</div>';
    }
    return html;
}

function _show_spc_legend(geojson, hazard) {
    if (_spcLegendHideTimer) { clearTimeout(_spcLegendHideTimer); _spcLegendHideTimer = null; }
    var $el = $('#lmSpcLegend');
    if (!$el.length) return;
    var html = _build_spc_legend_html(geojson, hazard);
    if (!html) return;
    $('#lmSpcLegendBody').html(html);
    $el.show();
    void $el[0].offsetWidth;
    $el.addClass('lmSpcLegend-visible');
}

function _hide_spc_legend() {
    if (_spcLegendHideTimer) { clearTimeout(_spcLegendHideTimer); _spcLegendHideTimer = null; }
    var $el = $('#lmSpcLegend');
    $el.removeClass('lmSpcLegend-visible');
    _spcLegendHideTimer = setTimeout(function () { _spcLegendHideTimer = null; $el.hide(); }, 400);
}

function _cluster_quakes_into_zones(quakes) {
    var CLUSTER_RADIUS_DEG = 4;
    var zones = [];
    for (var i = 0; i < quakes.length; i++) {
        var q = quakes[i];
        var lon = q.geometry.coordinates[0];
        var lat = q.geometry.coordinates[1];
        var placed = false;
        for (var z = 0; z < zones.length; z++) {
            var dLon = Math.abs(lon - zones[z].centroid[0]);
            var dLat = Math.abs(lat - zones[z].centroid[1]);
            if (dLon < CLUSTER_RADIUS_DEG && dLat < CLUSTER_RADIUS_DEG) {
                zones[z].quakes.push(q);
                var n = zones[z].quakes.length;
                zones[z].centroid[0] = zones[z].centroid[0] + (lon - zones[z].centroid[0]) / n;
                zones[z].centroid[1] = zones[z].centroid[1] + (lat - zones[z].centroid[1]) / n;
                if (!zones[z].newestTime || new Date(q.properties.time) > zones[z].newestTime) {
                    zones[z].newestTime = new Date(q.properties.time);
                }
                placed = true;
                break;
            }
        }
        if (!placed) {
            zones.push({
                centroid: [lon, lat],
                quakes: [q],
                newestTime: new Date(q.properties.time)
            });
        }
    }
    zones.sort(function (a, b) { return b.newestTime - a.newestTime; });
    return zones;
}

function _eq_zone_bbox(zone) {
    var minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
    for (var i = 0; i < zone.quakes.length; i++) {
        var c = zone.quakes[i].geometry.coordinates;
        if (c[0] < minLon) minLon = c[0];
        if (c[0] > maxLon) maxLon = c[0];
        if (c[1] < minLat) minLat = c[1];
        if (c[1] > maxLat) maxLat = c[1];
    }
    return [[minLon, minLat], [maxLon, maxLat]];
}

function _run_earthquake_segment(resolve) {
    _currentSegmentType = 'earthquake';
    _set_segment_stage('enter');
    _record_segment('earthquake', 'earthquake');
    _set_clock_mode('hidden');
    _hide_header_radar_info(null);

    _hide_all_map_overlays();
    _clear_active_station_selection();
    _remove_static_mrms_layer();
    _remove_conditions_layer();
    _remove_earthquake_layer();

    function _cleanup() {
        _set_segment_stage('finish');
        _stop_typewriter();
        _remove_earthquake_layer();
        _show_header_radar_info();
        _hide_eq_legend();
        _hide_info_panel();
        resolve();
    }

    _fetch_earthquakes(function (quakes) {
        if (!_active) { _show_header_radar_info(); return resolve(); }
        _set_segment_stage('fetch-ready');

        if (quakes.length > 0) {
            var rc = quakes[0].geometry.coordinates;
            map.flyTo({ center: [rc[0], rc[1]], zoom: 7, speed: 1.2, essential: true });
        } else {
            map.flyTo({ center: CONUS_CENTER, zoom: 4.0, speed: 1.2, essential: true });
        }

        _show_info_panel(_build_earthquake_panel_html(quakes));
        _show_eq_legend();

        if (quakes.length === 0) {
            _typewrite(_generate_earthquake_commentary(quakes), 1200);
            _segmentTimer = setTimeout(function () {
                _wait_for_typewriter_then(function () { _cleanup(); });
            }, 12000);
            return;
        }

        _trackAlertTimer(function () {
            if (!_active) return _cleanup();
            _set_segment_stage('plot');
            _add_earthquake_layer(quakes);
            _typewrite(_generate_earthquake_commentary(quakes), 1200);

            var zones = _cluster_quakes_into_zones(quakes);

            if (zones.length <= 1) {
                _segmentTimer = setTimeout(function () {
                    _wait_for_typewriter_then(function () { _cleanup(); });
                }, EARTHQUAKE_DURATION_MS);
            } else {
                var OVERVIEW_MS = Math.floor(EARTHQUAKE_DURATION_MS * 0.4);
                var PAN_TOTAL_MS = EARTHQUAKE_DURATION_MS - OVERVIEW_MS;
                var DWELL_PER_ZONE = Math.floor(PAN_TOTAL_MS / (zones.length - 1));
                var zoneIndex = 1;

                function _pan_next_zone() {
                    if (!_active || zoneIndex >= zones.length) {
                        _segmentTimer = setTimeout(function () {
                            _wait_for_typewriter_then(function () { _cleanup(); });
                        }, Math.min(DWELL_PER_ZONE, 5000));
                        return;
                    }
                    var zone = zones[zoneIndex];
                    if (zone.quakes.length === 1) {
                        var qc = zone.quakes[0].geometry.coordinates;
                        map.flyTo({ center: [qc[0], qc[1]], zoom: 7, speed: 0.8, essential: true });
                    } else {
                        var bbox = _eq_zone_bbox(zone);
                        map.fitBounds(bbox, { padding: 60, maxZoom: 8, speed: 0.8, essential: true });
                    }
                    zoneIndex++;
                    _segmentTimer = setTimeout(_pan_next_zone, DWELL_PER_ZONE);
                }

                _segmentTimer = setTimeout(function () {
                    if (!_active) return _cleanup();
                    _pan_next_zone();
                }, OVERVIEW_MS);
            }
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

var _SEGMENT_DEBUG_LABELS = {
    spc: 'SPC',
    alert: 'ALERT',
    conus: 'CONUS',
    spotlight: 'SPOTLIGHT',
    conditions: 'CONDITIONS',
    earthquake: 'EARTHQUAKE'
};
var _segmentDebugEnabled = false;

function _set_segment_debug(type, suffix) {
    var el = document.getElementById('liveModeSegmentDebug');
    if (!el) return;

    if (!_segmentDebugEnabled) {
        el.style.display = 'none';
        return;
    }
    el.style.display = 'inline-flex';

    if (!_active) {
        el.textContent = 'SEG: OFF';
        return;
    }

    var key = String(type || _currentSegmentType || '').toLowerCase();
    var base = _SEGMENT_DEBUG_LABELS[key] || (key ? key.toUpperCase() : 'IDLE');
    if (suffix) {
        el.textContent = 'SEG: ' + base + ' (' + String(suffix).toUpperCase() + ')';
    } else {
        el.textContent = 'SEG: ' + base;
    }
}

function _set_segment_stage(stage) {
    _set_segment_debug(_currentSegmentType, stage);
}

function setSegmentDebugEnabled(enabled) {
    _segmentDebugEnabled = !!enabled;
    _set_segment_debug(_currentSegmentType);
}

// ── New-Alert Banner ─────────────────────────────────────────────────────────

var _alertBannerEl = null;
var _alertBannerTimeout = null;
var _alertBannerFadeTimeout = null;
var _alertBannerQueue = [];
var _alertBannerShowing = false;
var _ALERT_BANNER_MIN_MS = 10000;
var _ALERT_BANNER_MAX_MS = 15000;
var _ALERT_BANNER_EXIT_MS = 560;

function _ensure_alert_banner_el() {
    if (_alertBannerEl) return;
    _alertBannerEl = document.createElement('div');
    _alertBannerEl.className = 'lmAlertBanner';
    var host = document.getElementById('top-right');
    (host || document.body).appendChild(_alertBannerEl);
}

function _position_alert_banner() {
    if (!_alertBannerEl) return;
    var host = document.getElementById('top-right');
    var btn = document.getElementById('alertsCountBtn');
    if (!btn) return;
    if (host) {
        if (_alertBannerEl.parentElement !== host) host.appendChild(_alertBannerEl);
        var tuckUnderPx = Math.round(Math.min(btn.offsetWidth * 0.28, 14));
        var gapPx = 0;
        var btnRect = btn.getBoundingClientRect();
        var maxBannerWidthPx = Math.max(140, Math.floor(btnRect.left + tuckUnderPx - 12));
        var safeRightTextInsetPx = tuckUnderPx + 6;
        _alertBannerEl.style.top = btn.offsetTop + 'px';
        _alertBannerEl.style.height = btn.offsetHeight + 'px';
        _alertBannerEl.style.right = Math.max(0, (host.clientWidth - btn.offsetLeft) - tuckUnderPx + gapPx) + 'px';
        _alertBannerEl.style.maxWidth = maxBannerWidthPx + 'px';
        _alertBannerEl.style.setProperty('--lmAlertBannerSafeRight', safeRightTextInsetPx + 'px');
        return;
    }

    var rect = btn.getBoundingClientRect();
    var fallbackTuckUnderPx = Math.round(Math.min(rect.width * 0.28, 14));
    var fallbackGapPx = 0;
    var fallbackLeftSpacePx = Math.max(140, Math.floor(rect.left - 12 + fallbackTuckUnderPx - fallbackGapPx));
    var fallbackMaxWidthPx = fallbackLeftSpacePx;
    var fallbackSafeRightTextInsetPx = fallbackTuckUnderPx + 6;
    _alertBannerEl.style.top = rect.top + 'px';
    _alertBannerEl.style.height = rect.height + 'px';
    _alertBannerEl.style.right = Math.max(0, (window.innerWidth - rect.left) - fallbackTuckUnderPx + fallbackGapPx) + 'px';
    _alertBannerEl.style.maxWidth = fallbackMaxWidthPx + 'px';
    _alertBannerEl.style.setProperty('--lmAlertBannerSafeRight', fallbackSafeRightTextInsetPx + 'px');
}

function _format_alert_banner_locations(states) {
    if (!Array.isArray(states) || states.length === 0) return '';
    var clean = states
        .map(function (s) { return (s == null ? '' : String(s)).trim(); })
        .filter(function (s) { return s.length > 0; });
    if (!clean.length) return '';
    if (clean.length === 1) return clean[0];
    if (clean.length === 2) return clean[0] + ' and ' + clean[1];
    return clean.slice(0, -1).join(', ') + ', and ' + clean[clean.length - 1];
}

function _show_alert_banner(eventName, states) {
    _ensure_alert_banner_el();
    var colorInfo = get_polygon_colors(eventName);
    var bgColor = colorInfo ? colorInfo.color : 'rgb(255, 0, 255)';

    var text = 'New ' + eventName;
    var locationList = _format_alert_banner_locations(states);
    if (locationList) text += ' in ' + locationList;
    var category = _get_alert_category_for_banner(eventName);
    var iconClass = (ALERT_CATEGORY_ICON_META[category] || ALERT_CATEGORY_ICON_META.Other).icon;
    _alertBannerEl.innerHTML =
        '<i class="lmAlertBannerIcon fa-solid ' + iconClass + '" aria-hidden="true"></i>' +
        '<span class="lmAlertBannerText">' + _escape_html(text) + '</span>';
    _alertBannerEl.style.background = bgColor;

    _alertBannerEl.style.color = '#000';

    _position_alert_banner();
    _alertBannerEl.classList.remove('lmAlertBanner-visible', 'lmAlertBanner-closing');
    void _alertBannerEl.offsetWidth;
    _alertBannerEl.classList.add('lmAlertBanner-visible');
    _alertBannerShowing = true;
    _set_clock_suppressed(true);

    if (_alertBannerTimeout) clearTimeout(_alertBannerTimeout);
    if (_alertBannerFadeTimeout) clearTimeout(_alertBannerFadeTimeout);
    var visibleMs = _ALERT_BANNER_MIN_MS + Math.floor(Math.random() * ((_ALERT_BANNER_MAX_MS - _ALERT_BANNER_MIN_MS) + 1));

    _alertBannerTimeout = setTimeout(function () {
        if (!_alertBannerEl) return;
        _alertBannerEl.classList.remove('lmAlertBanner-visible');
        _alertBannerEl.classList.add('lmAlertBanner-closing');
        _alertBannerFadeTimeout = setTimeout(function () {
            if (_alertBannerEl) _alertBannerEl.classList.remove('lmAlertBanner-visible', 'lmAlertBanner-closing');
            _alertBannerShowing = false;
            _set_clock_suppressed(false);
            _drain_alert_banner_queue();
        }, _ALERT_BANNER_EXIT_MS);
    }, visibleMs);
}

function _drain_alert_banner_queue() {
    if (_alertBannerShowing) return;
    if (_alertBannerQueue.length === 0) return;
    var next = _alertBannerQueue.shift();
    _show_alert_banner(next.event, next.states);
}

function _hide_alert_banner() {
    _alertBannerQueue = [];
    _alertBannerShowing = false;
    if (_alertBannerTimeout) { clearTimeout(_alertBannerTimeout); _alertBannerTimeout = null; }
    if (_alertBannerFadeTimeout) { clearTimeout(_alertBannerFadeTimeout); _alertBannerFadeTimeout = null; }
    if (_alertBannerEl) {
        _alertBannerEl.classList.remove('lmAlertBanner-visible', 'lmAlertBanner-closing');
    }
    _set_clock_suppressed(false);
}

var _alertBannerListener = null;

function _enable_alert_banner() {
    if (_alertBannerListener) return;
    _alertBannerListener = function (e) {
        if (!_active) return;
        var detail = e?.detail;
        if (!detail || detail.type !== 'new') return;
        var eventName = detail.event || '';
        if (!eventName) return;
        var states = detail.states || [];
        if (_alertBannerShowing) {
            _alertBannerQueue.push({ event: eventName, states: states });
        } else {
            _show_alert_banner(eventName, states);
        }
    };
    window.addEventListener('alertNotification', _alertBannerListener);
}

function _disable_alert_banner() {
    _hide_alert_banner();
    if (_alertBannerListener) {
        window.removeEventListener('alertNotification', _alertBannerListener);
        _alertBannerListener = null;
    }
}

var _infoPanelFadeTimer = null;
var _spotlightForecastPanelFadeTimer = null;

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

function _show_spotlight_forecast_panel(html, options) {
    options = options || {};
    var animate = options.animate !== false;
    if (_spotlightForecastPanelFadeTimer) { clearTimeout(_spotlightForecastPanelFadeTimer); _spotlightForecastPanelFadeTimer = null; }
    var $p = $('#liveModeSpotlightForecastPanel');
    $p.removeClass('liveModeSpotlightForecastPanel-fading');
    if (animate) $p.removeClass('liveModeSpotlightForecastPanel-noanim');
    else $p.addClass('liveModeSpotlightForecastPanel-noanim');
    $p.html(html).addClass('liveModeSpotlightForecastPanel-visible');
}

function _hide_spotlight_forecast_panel() {
    _spotlightForecastRequestEpoch++;
    if (_spotlightForecastPanelFadeTimer) { clearTimeout(_spotlightForecastPanelFadeTimer); _spotlightForecastPanelFadeTimer = null; }
    var $p = $('#liveModeSpotlightForecastPanel');
    if (!$p.hasClass('liveModeSpotlightForecastPanel-visible')) { $p.html(''); return; }
    $p.removeClass('liveModeSpotlightForecastPanel-noanim');
    $p.addClass('liveModeSpotlightForecastPanel-fading');
    _spotlightForecastPanelFadeTimer = setTimeout(function () {
        $p.removeClass('liveModeSpotlightForecastPanel-visible liveModeSpotlightForecastPanel-fading liveModeSpotlightForecastPanel-noanim').html('');
        _spotlightForecastPanelFadeTimer = null;
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
    options.push({ type: 'storm_reports', weight: 3 });
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
            if (options[k].type === 'storm_reports') options[k].weight = 2;
            if (options[k].type === 'conus') options[k].weight += 2;
        }
    }

    // Quiet weather — diversify content
    if (!hasAnySevere) {
        for (var i = 0; i < options.length; i++) {
            if (options[i].type === 'spotlight') options[i].weight += 2;
            if (options[i].type === 'conditions') options[i].weight += 2;
            if (options[i].type === 'storm_reports') options[i].weight += 2;
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
            if (options[n].type === 'storm_reports') options[n].weight += 1;
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
        options = [
            { type: 'spc', weight: 1 },
            { type: 'conus', weight: 1 },
            { type: 'spotlight', weight: 2 },
            { type: 'conditions', weight: 1 },
            { type: 'storm_reports', weight: 1 },
            { type: 'earthquake', weight: 1 }
        ];
        if (hasAnySevere) options.push({ type: 'alert', weight: 3 });
    }

    return _weighted_pick(options);
}

// ── Director Loop ────────────────────────────────────────────────────────────

function _full_segment_cleanup(options) {
    options = options || {};
    var zoomOutAfterAlert = !!options.zoomOutAfterAlert;
    var previousSegmentType = _currentSegmentType;
    _set_segment_stage('cleanup');
    _currentSegmentType = null;
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
    _remove_live_storm_reports_layer();
    _hide_radar_render();
    _hide_station_markers();
    _hide_radar_sweep();
    _hide_lightning_overlay();
    _clear_active_station_selection();
    _hide_alert_polygons();
    _hide_header_radar_info(null, { allowSocialFallback: false });
    _hide_eq_legend();
    _hide_cond_legend();
    _hide_spc_legend();
    _hide_info_panel();
    _hide_spotlight_forecast_panel();
    _hide_segment_label();

    var controller = window.stormTrackData?.radarLoopController;
    if (controller) {
        try { controller.stop(); } catch (_) {}
        controller.state.frames = [];
        controller.state.currentFrameIndex = 0;
    }

    if (zoomOutAfterAlert && previousSegmentType === 'alert') {
        _reset_to_reflectivity();
        try {
            map.flyTo({ center: CONUS_CENTER, zoom: CONUS_ZOOM, speed: 1.2, essential: true });
        } catch (_) {}
    }
}

function _run_next() {
    if (!_active) return;

    var type = _pick_next_segment();
    _flash_transition();
    _show_segment_label(type);
    _set_segment_debug(type, 'queued');

    function advance() {
        if (!_active) return;
        _full_segment_cleanup({ zoomOutAfterAlert: true });
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
    } else if (type === 'storm_reports') {
        _run_storm_reports_segment(advance);
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
    var isTornadoEventName = TORNADO_EVENTS.includes(eventName) ||
        String(eventName).trim().toLowerCase() === 'tornado warning';
    var isNewTornado = detail.type === 'new' && isTornadoEventName;
    var isUpgradedTornado = (detail.type === 'updated' || detail.type === 'new')
        && isTornadoEventName
        && String(detail.tornadoStatus || '').toLowerCase() === 'upgraded';
    if (!isNewTornado && !isUpgradedTornado) return;

    // Find the actual tornado warning feature from alert data
    var alerts = _get_active_severe_alerts();
    var torFeature = null;
    var nowMs = Date.now();
    var targetAlertId = detail.alertId || null;
    var bestScore = -Infinity;
    for (var i = 0; i < alerts.length; i++) {
        if (!TORNADO_EVENTS.includes(alerts[i]?.properties?.event)) continue;
        var alertId = alerts[i]?.id || alerts[i]?.properties?.id || null;
        if (targetAlertId && alertId === targetAlertId) {
            torFeature = alerts[i];
            break;
        }
        var interruptContext = _get_alert_focus_context(alerts[i]);
        if (_is_tornado_focus_blocked(interruptContext, nowMs)) continue;
        var score = _score_alert_for_focus(alerts[i], interruptContext, nowMs);
        if (score > bestScore) {
            bestScore = score;
            torFeature = alerts[i];
        }
    }
    if (!torFeature) return;

    _abort_current_segment();
    _set_segment_debug('alert', isUpgradedTornado ? 'interrupt-upgraded' : 'interrupt');
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

    _show_radar_render();
    _show_station_markers();
    _show_alert_polygons();
    _show_radar_sweep();
    _show_lightning_overlay();

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
    _alertVisitHistory = Object.create(null);
    _alertFocusClassHistory = Object.create(null);
    _consecutiveTornadoFocusCount = 0;
    _set_segment_debug('idle', 'starting');

    _save_state();
    _show_overlay();
    _lock_map();

    _tornadoInterruptListener = _on_tornado_interrupt;
    window.addEventListener('alertNotification', _tornadoInterruptListener);

    _escapeListener = function (e) {
        if (e.key === 'Escape') disable();
    };
    document.addEventListener('keydown', _escapeListener);

    if (!_preLiveModeAlertBlinkCaptured) {
        _preLiveModeAlertBlinkEnabled = window.stormTrackData ? window.stormTrackData.alertBlinkEnabled : undefined;
        _preLiveModeAlertBlinkCaptured = true;
    }
    if (window.stormTrackData) window.stormTrackData.alertBlinkEnabled = false;
    try {
        var plotAlerts = require('../alerts/plot_alerts');
        if (plotAlerts && plotAlerts.clear_blinking_focus) plotAlerts.clear_blinking_focus();
    } catch (_) {}

    window.stormTrackData.liveModeActive = true;
    _bind_sweep_sync_listeners();
    _start_non_site_guard();
    _apply_live_mode_lightning_style();

    var updater = window.stormTrackData?.current_RadarUpdater;
    if (updater) updater.disable();

    _hide_storm_reports();
    _enable_alert_banner();

    setTimeout(_run_next, 800);
}

function disable() {
    if (!_active) return;
    _active = false;
    _set_segment_debug(null);
    window.stormTrackData.liveModeActive = false;
    if (_preLiveModeAlertBlinkCaptured && window.stormTrackData) {
        window.stormTrackData.alertBlinkEnabled = _preLiveModeAlertBlinkEnabled;
        _preLiveModeAlertBlinkCaptured = false;
        _preLiveModeAlertBlinkEnabled = undefined;
    }
    _stop_non_site_guard();
    _unbind_sweep_sync_listeners();

    stopMusic();
    _abort_current_segment();
    _disable_alert_banner();
    _show_header_radar_info();
    _set_clock_mode('both');
    _hide_overlay();
    _unlock_map();
    _restore_live_mode_lightning_style();
    _restore_state();
    _show_storm_reports();

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
    'music/After the Rain.mp3',
    'music/Blue Sky Window.mp3',
    'music/Calm Pressure.mp3',
    'music/Cycle A.mp3',
    'music/Data Stream.mp3',
    'music/Digital Sky.mp3',
    'music/Fade.mp3',
    'music/Low Signal.mp3',
    'music/Lowlight.mp3',
    'music/Mesoman.mp3',
    'music/Open Atmosphere.mp3',
    'music/Phase Drift.mp3',
    'music/Rain or Shine.mp3',
    'music/Skyfall.mp3',
    'music/Slow Horizon.mp3',
    'music/Stormfront.mp3',
    'music/Streamline.mp3'
];

const _musicController = new LiveModeMusicController({
    settingsStore: settings_store,
    tracks: _MUSIC_TRACKS
});

function startMusic() {
    _musicController.start();
}

function stopMusic() {
    _musicController.stop();
}

function setMusicVolume(pct) {
    _musicController.setVolume(pct);
}

// ── Music Ducking (lower volume during warning sounds) ──────────────────────

function duckMusic(fadeDurationMs) {
    _musicController.duck(fadeDurationMs);
}

function unduckMusic(fadeDurationMs) {
    _musicController.unduck(fadeDurationMs);
}

function _resolve_forced_alert_feature(options) {
    var target = String(options?.eventName || '').trim().toLowerCase();
    if (!target) return null;
    if (target === 'sps') target = 'special weather statement';

    var alerts = _get_active_severe_alerts();
    for (var i = 0; i < alerts.length; i++) {
        var eventName = String(alerts[i]?.properties?.event || '').trim().toLowerCase();
        if (eventName === target) return alerts[i];
    }
    return null;
}

function forceSegment(type, options) {
    if (!_active) {
        enable();
    }
    _abort_current_segment();
    _flash_transition();
    _show_segment_label(type);
    _set_segment_debug(type, 'forced');

    function advance() {
        if (!_active) return;
        _clear_segment_timer();
        _hide_segment_label();
        _trackAlertTimer(_run_next, 600);
    }

    if (type === 'spc') _run_spc_segment(advance);
    else if (type === 'alert') {
        var forceFeature = _resolve_forced_alert_feature(options);
        _run_alert_segment(advance, forceFeature);
    }
    else if (type === 'spotlight') _run_spotlight_segment(advance);
    else if (type === 'conditions') _run_conditions_segment(advance);
    else if (type === 'storm_reports') _run_storm_reports_segment(advance);
    else if (type === 'earthquake') _run_earthquake_segment(advance);
    else if (type === 'conus') _run_conus_segment(advance);
    else return false;
    return true;
}

module.exports = { enable, disable, isActive, startMusic, stopMusic, setMusicVolume, duckMusic, unduckMusic, forceSegment, setSegmentDebugEnabled };
