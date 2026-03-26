const MAPBOX_TOKEN = 'pk.eyJ1IjoidHdhbGtlcjkyIiwiYSI6ImNtZDkwaHMwdTAyazkya3BzNXphYWI3a2kifQ.sWYO653OYlYHYc_wOHsd2A';
const SOURCE_ID = 'spcOutlooksSource';
const HATCH_SOURCE_ID = 'spcOutlooksHatchedSource';
const FILL_LAYER_ID = 'spcOutlooksFill';
const LINE_LAYER_ID = 'spcOutlooksLine';
const BASE_URL = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/MapServer';
const SATELLITE_SOURCE_ID = 'spcOutlooksSatelliteSource';
const SATELLITE_LAYER_ID = 'spcOutlooksSatelliteLayer';
const URL_PARAM_SPC = 'spc';
const URL_PARAM_SPC_DAY = 'spcDay';
const URL_PARAM_SPC_HAZARD = 'spcHazard';
const URL_PARAM_SPC_RADAR = 'spcRadar';
const URL_PARAM_SPC_VALID_FROM_DATE = 'spcValidFromDate';
const URL_PARAM_SPC_VALID_UNTIL_DATE = 'spcValidUntilDate';
const NWS_UA = '(Vortex Radar, https://vortexradar.snapsera.com)';

const DAY_HAZARD_LAYER_IDS = {
    day1: { categorical: 1, tornado: 3, hail: 5, wind: 7 },
    day2: { categorical: 9, tornado: 11, hail: 13, wind: 15 },
    day3: { categorical: 17, tornado: 19, hail: 19, wind: 19 }
};

let _overlay = null;
let _map = null;
let _mainMap = null;
let _locationMarker = null;
let _activeDay = 'day1';
let _activeHazard = 'categorical';
let _radarEnabled = false;
let _isLoading = false;
let _drawEnabled = false;
let _overlayCanvas = null;
let _overlayCtx = null;
let _drawCanvas = null;
let _drawCtx = null;
let _drawLast = null;
let _hiddenGlobalButtons = {};
let _shareValidFromDate = '';
let _shareValidUntilDate = '';
let _spcRegularFeatures = [];
let _spcHatchedFeatures = [];
let _spcCigFeatures = [];
let _spcLegendItems = [];
let _categoricalRiskByDay = {};
let _dayHazardFeatureCache = {};
let _locationAssessLat = null;
let _locationAssessLon = null;
let _locationAssessName = '';
let _locationSearchDebounce = null;
const DRAW_SETTINGS_KEY = 'vortexRadar_draw_settings';
let _openHydrationTimers = [];

function _set_empty_message(text) {
    const $empty = $('#spcOutlooksEmpty');
    if (!text) {
        $empty.removeClass('spcOutlooksEmpty-visible');
        return;
    }
    $empty.text(text).addClass('spcOutlooksEmpty-visible');
}

function _format_spc_time(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    if (!/^\d{12}$/.test(s)) return null;
    const year = Number(s.slice(0, 4));
    const month = Number(s.slice(4, 6));
    const day = Number(s.slice(6, 8));
    const hour = Number(s.slice(8, 10));
    const minute = Number(s.slice(10, 12));
    const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute));
    if (!Number.isFinite(utcDate.getTime())) return null;

    const dateLabel = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric'
    }).format(utcDate);

    const timeLabel = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZoneName: 'short'
    }).format(utcDate);

    return { dateLabel: dateLabel, timeLabel: timeLabel };
}

function _format_datetime_et(dateObj) {
    if (!(dateObj instanceof Date) || !Number.isFinite(dateObj.getTime())) return '';
    const datePart = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric'
    }).format(dateObj);
    const timePart = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZoneName: 'short'
    }).format(dateObj);
    return `${datePart} ${timePart}`;
}

function _parse_spc_timestamp(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const s = String(raw).trim();
    if (/^\d{12}$/.test(s)) {
        const year = Number(s.slice(0, 4));
        const month = Number(s.slice(4, 6));
        const day = Number(s.slice(6, 8));
        const hour = Number(s.slice(8, 10));
        const minute = Number(s.slice(10, 12));
        const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute));
        return Number.isFinite(utcDate.getTime()) ? utcDate : null;
    }
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) {
        const d = new Date(n);
        return Number.isFinite(d.getTime()) ? d : null;
    }
    return null;
}

function _set_last_updated_subtitle(featureCollection) {
    const features = (featureCollection && featureCollection.features) || [];
    let latestMs = 0;

    for (let i = 0; i < features.length; i++) {
        const p = (features[i] && features[i].properties) || {};
        const issueDate = _parse_spc_timestamp(p.issue);
        const fileDate = _parse_spc_timestamp(p.idp_filedate);
        const ingestDate = _parse_spc_timestamp(p.idp_ingestdate);
        const best = issueDate || fileDate || ingestDate;
        if (best && best.getTime() > latestMs) latestMs = best.getTime();
    }

    if (!latestMs) {
        $('#spcOutlooksHeaderSub').text('Last updated: --');
        return;
    }

    const label = _format_datetime_et(new Date(latestMs));
    $('#spcOutlooksHeaderSub').text(`Last updated: ${label || '--'}`);
}

function _set_validity_panel(featureCollection) {
    const $panel = $('#spcOutlooksValidity');
    const features = (featureCollection && featureCollection.features) || [];
    const first = features[0] && features[0].properties ? features[0].properties : null;
    _set_last_updated_subtitle(featureCollection);
    const validInfo = _format_spc_time(first && first.valid);
    const expireInfo = _format_spc_time(first && first.expire);
    _shareValidFromDate = validInfo ? validInfo.dateLabel : '';
    _shareValidUntilDate = expireInfo ? expireInfo.dateLabel : '';
    _set_spc_share_url();

    if (!validInfo && !expireInfo) {
        $panel.removeClass('spcOutlooksValidity-visible');
        return;
    }

    $('#spcOutlooksValidFromDate').text(validInfo ? validInfo.dateLabel : '--');
    $('#spcOutlooksValidFromTime').text(validInfo ? validInfo.timeLabel : '--');
    $('#spcOutlooksValidUntilDate').text(expireInfo ? expireInfo.dateLabel : '--');
    $('#spcOutlooksValidUntilTime').text(expireInfo ? expireInfo.timeLabel : '--');
    $panel.addClass('spcOutlooksValidity-visible');
    _fit_validity_text();
}

function _fit_text_to_width($el, maxPx, minPx) {
    if (!$el || !$el.length) return;
    $el.css('font-size', maxPx + 'px');
    let size = maxPx;
    const el = $el.get(0);
    while (size > minPx && el.scrollWidth > el.clientWidth) {
        size -= 1;
        $el.css('font-size', size + 'px');
    }
}

function _fit_validity_text() {
    const $from = $('#spcOutlooksValidFromDate');
    const $until = $('#spcOutlooksValidUntilDate');
    if (!$from.length || !$until.length) return;
    _fit_text_to_width($from, 26, 12);
    _fit_text_to_width($until, 26, 12);
}

function _layer_id_for(day, hazard) {
    const dayConfig = DAY_HAZARD_LAYER_IDS[day] || DAY_HAZARD_LAYER_IDS.day1;
    return dayConfig[hazard] || dayConfig.categorical;
}

function _build_query_url(layerId) {
    return `${BASE_URL}/${layerId}/query?where=1%3D1&outFields=*&f=geojson`;
}

function _geocode_location(query, cb) {
    const url = 'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(query) +
        '&format=json&countrycodes=us&limit=5&addressdetails=1';
    fetch(url, { headers: { 'User-Agent': NWS_UA } })
        .then((r) => r.json())
        .then((data) => cb(null, data || []))
        .catch((err) => cb(err, []));
}

function _display_name_from_geocode(item) {
    const addr = (item && item.address) || {};
    const city = addr.city || addr.town || addr.village || addr.hamlet || addr.county || '';
    const state = addr.state || '';
    if (city && state) return city + ', ' + state;
    if (item && item.display_name) return item.display_name.split(',').slice(0, 3).join(',');
    return (item && item.display_name) || 'Unknown';
}

function _read_spc_share_params() {
    try {
        const params = new URLSearchParams(window.location.search);
        if (params.get(URL_PARAM_SPC) !== '1') return null;
        return {
            day: params.get(URL_PARAM_SPC_DAY) || 'day1',
            hazard: params.get(URL_PARAM_SPC_HAZARD) || 'categorical',
            radar: params.get(URL_PARAM_SPC_RADAR) === '1',
            validFromDate: params.get(URL_PARAM_SPC_VALID_FROM_DATE) || '',
            validUntilDate: params.get(URL_PARAM_SPC_VALID_UNTIL_DATE) || ''
        };
    } catch (_) {
        return null;
    }
}

function _set_spc_share_url() {
    try {
        const url = new URL(window.location.href);
        url.searchParams.set(URL_PARAM_SPC, '1');
        url.searchParams.set(URL_PARAM_SPC_DAY, _activeDay);
        url.searchParams.set(URL_PARAM_SPC_HAZARD, _activeHazard);
        url.searchParams.set(URL_PARAM_SPC_RADAR, _radarEnabled ? '1' : '0');
        if (_shareValidFromDate) {
            url.searchParams.set(URL_PARAM_SPC_VALID_FROM_DATE, _shareValidFromDate);
        }
        if (_shareValidUntilDate) {
            url.searchParams.set(URL_PARAM_SPC_VALID_UNTIL_DATE, _shareValidUntilDate);
        }
        window.history.replaceState({}, '', url.toString());
    } catch (_) {}
}

function _clear_spc_share_url() {
    try {
        const url = new URL(window.location.href);
        url.searchParams.delete(URL_PARAM_SPC);
        url.searchParams.delete(URL_PARAM_SPC_DAY);
        url.searchParams.delete(URL_PARAM_SPC_HAZARD);
        url.searchParams.delete(URL_PARAM_SPC_RADAR);
        url.searchParams.delete(URL_PARAM_SPC_VALID_FROM_DATE);
        url.searchParams.delete(URL_PARAM_SPC_VALID_UNTIL_DATE);
        window.history.replaceState({}, '', url.toString());
    } catch (_) {}
}

function _hide_global_corner_buttons() {
    const ids = ['#fullscreenToggleBtn', '#devConsoleQuickBtn'];
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const $el = $(id);
        if (!$el.length) continue;
        _hiddenGlobalButtons[id] = $el.css('display');
        $el.css('display', 'none');
    }
}

function _restore_global_corner_buttons() {
    const ids = Object.keys(_hiddenGlobalButtons);
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const $el = $(id);
        if (!$el.length) continue;
        $el.css('display', _hiddenGlobalButtons[id] || '');
    }
    _hiddenGlobalButtons = {};
}

function _copy_paint_if_available(layerId, paintKey) {
    if (!_mainMap || !_map) return;
    if (!_mainMap.getLayer(layerId) || !_map.getLayer(layerId)) return;
    const value = _mainMap.getPaintProperty(layerId, paintKey);
    if (value !== undefined) {
        _map.setPaintProperty(layerId, paintKey, value);
    }
}

function _set_satellite_visibility(showSatellite) {
    const hasSatellite = !!_map.getLayer(SATELLITE_LAYER_ID);
    if (showSatellite && !hasSatellite) {
        if (!_map.getSource(SATELLITE_SOURCE_ID)) {
            _map.addSource(SATELLITE_SOURCE_ID, { type: 'raster', url: 'mapbox://mapbox.satellite', tileSize: 256 });
        }
        const beforeLayer = _map.getLayer('tunnel-path-trail') ? 'tunnel-path-trail' : undefined;
        _map.addLayer({ type: 'raster', id: SATELLITE_LAYER_ID, source: SATELLITE_SOURCE_ID }, beforeLayer);
    } else if (!showSatellite && hasSatellite) {
        _map.removeLayer(SATELLITE_LAYER_ID);
        _map.removeSource(SATELLITE_SOURCE_ID);
    }
}

function _apply_theme_from_map_type() {
    if (!_map || !_map.loaded()) return;
    const mapType = (window.stormTrackData && window.stormTrackData.map_type) || 'dark';
    const isLight = mapType === 'light';
    const isSatellite = mapType === 'satellite';

    function _safe_set(layerId, key, value) {
        if (_map.getLayer(layerId)) _map.setPaintProperty(layerId, key, value);
    }

    if (isLight) {
        _safe_set('land', 'background-color', 'rgb(246, 244, 237)');
        _safe_set('national-park', 'fill-color', 'rgb(246, 244, 237)');
        _safe_set('landuse', 'fill-color', 'rgb(246, 244, 237)');
        _safe_set('water', 'fill-color', 'rgb(136, 190, 227)');
        _safe_set('state-label', 'text-color', '#3d4554');
        _safe_set('country-label', 'text-color', '#3d4554');
        _safe_set('settlement-major-label', 'text-color', '#3d4554');
        _safe_set('settlement-minor-label', 'text-color', '#3d4554');
        _safe_set('settlement-subdivision-label', 'text-color', '#3d4554');
        _safe_set('water-point-label', 'text-color', '#4a6e8a');
        _safe_set('water-line-label', 'text-color', '#4a6e8a');
        _safe_set('road-label-simple', 'text-color', '#555e6e');
    } else {
        _safe_set('land', 'background-color', '#1b1e2b');
        _safe_set('national-park', 'fill-color', '#1f2233');
        _safe_set('landuse', 'fill-color', '#1f2233');
        _safe_set('water', 'fill-color', '#141722');
        _safe_set('state-label', 'text-color', 'rgb(255, 255, 255)');
        _safe_set('country-label', 'text-color', 'rgb(255, 255, 255)');
        _safe_set('settlement-major-label', 'text-color', 'rgb(255, 255, 255)');
        _safe_set('settlement-minor-label', 'text-color', 'rgb(255, 255, 255)');
        _safe_set('settlement-subdivision-label', 'text-color', 'rgb(255, 255, 255)');
        _safe_set('water-point-label', 'text-color', '#4a5470');
        _safe_set('water-line-label', 'text-color', '#4a5470');
        _safe_set('road-label-simple', 'text-color', '#5a6378');
    }

    _set_satellite_visibility(isSatellite);
}

function _sync_basemap_theme_from_main() {
    if (!_map || !_map.loaded()) return;
    _apply_theme_from_map_type();
    if (!_mainMap || !_mainMap.loaded()) return;

    _copy_paint_if_available('land', 'background-color');
    _copy_paint_if_available('national-park', 'fill-color');
    _copy_paint_if_available('landuse', 'fill-color');
    _copy_paint_if_available('water', 'fill-color');
    _copy_paint_if_available('state-label', 'text-color');
    _copy_paint_if_available('state-label', 'text-halo-color');
    _copy_paint_if_available('country-label', 'text-color');
    _copy_paint_if_available('country-label', 'text-halo-color');
    _copy_paint_if_available('settlement-major-label', 'text-color');
    _copy_paint_if_available('settlement-major-label', 'text-halo-color');
    _copy_paint_if_available('settlement-minor-label', 'text-color');
    _copy_paint_if_available('settlement-minor-label', 'text-halo-color');
    _copy_paint_if_available('settlement-subdivision-label', 'text-color');
    _copy_paint_if_available('settlement-subdivision-label', 'text-halo-color');
    _copy_paint_if_available('water-point-label', 'text-color');
    _copy_paint_if_available('water-line-label', 'text-color');
    _copy_paint_if_available('road-label-simple', 'text-color');
    _copy_paint_if_available('admin-0-boundary', 'line-color');
    _copy_paint_if_available('admin-0-boundary-disputed', 'line-color');
    _copy_paint_if_available('admin-0-boundary-bg', 'line-color');
    _copy_paint_if_available('admin-1-boundary', 'line-color');

    _set_satellite_visibility(!!_mainMap.getLayer('satellite-map'));
}

function _is_hatched_feature(props) {
    const label = String((props && props.label) || '').toLowerCase();
    const label2 = String((props && props.label2) || '').toLowerCase();
    return label.indexOf('hatched') !== -1 || label2.indexOf('hatched') !== -1;
}

function _is_cig_feature(props) {
    const label = String((props && props.label) || '').toUpperCase();
    const label2 = String((props && props.label2) || '').toUpperCase();
    return label.indexOf('CIG') === 0 || label2.indexOf('CONDITIONAL INTENSITY GROUP') !== -1;
}

function _get_cig_level(props) {
    const label = String((props && props.label) || '');
    const label2 = String((props && props.label2) || '');
    const fromLabel = label.match(/CIG\s*([1-3])/i);
    if (fromLabel) return Number(fromLabel[1]);
    const fromLabel2 = label2.match(/INTENSITY\s*(?:LEVEL|GROUP)\s*([1-3])/i);
    if (fromLabel2) return Number(fromLabel2[1]);
    return 1;
}

function _build_legend_items(features) {
    const seen = new Set();
    const items = [];
    for (let i = 0; i < features.length; i++) {
        const p = features[i].properties || {};
        const key = [p.label || '', p.label2 || '', p.fill || '', p.stroke || '', p.spcIsHatched || 0, p.spcIsCig || 0].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
            label2: p.label2 || p.label || 'Risk',
            fill: p.fill || '#8dc6ff',
            stroke: p.stroke || '#59a9ff',
            isHatched: p.spcIsHatched === 1,
            isCig: p.spcIsCig === 1,
            cigLevel: Number(p.spcCigLevel) || 1
        });
    }
    return items;
}

function _risk_level_from_features(features) {
    const list = Array.isArray(features) ? features : [];
    let level = 0;
    for (let i = 0; i < list.length; i++) {
        const p = list[i].properties || {};
        const label = String(p.label || '').toUpperCase();
        const label2 = String(p.label2 || '').toUpperCase();
        const text = `${label} ${label2}`;
        if (text.indexOf('GENERAL THUNDER') !== -1 || label === 'TSTM') continue;
        if (text.indexOf('HIGH') !== -1) level = Math.max(level, 5);
        else if (text.indexOf('MODERATE') !== -1 || label === 'MDT') level = Math.max(level, 4);
        else if (text.indexOf('ENHANCED') !== -1 || label === 'ENH') level = Math.max(level, 3);
        else if (text.indexOf('SLIGHT') !== -1 || label === 'SLGT') level = Math.max(level, 2);
        else if (text.indexOf('MARGINAL') !== -1 || label === 'MRGL') level = Math.max(level, 1);
    }
    return level;
}

function _risk_level_for_props(props) {
    const p = props || {};
    const label = String(p.label || '').toUpperCase();
    const label2 = String(p.label2 || '').toUpperCase();
    const text = `${label} ${label2}`;
    if (text.indexOf('HIGH') !== -1 || label === 'HIGH') return 5;
    if (text.indexOf('MODERATE') !== -1 || label === 'MDT') return 4;
    if (text.indexOf('ENHANCED') !== -1 || label === 'ENH') return 3;
    if (text.indexOf('SLIGHT') !== -1 || label === 'SLGT') return 2;
    if (text.indexOf('MARGINAL') !== -1 || label === 'MRGL') return 1;
    return 0;
}

function _risk_display_from_features(features) {
    const list = Array.isArray(features) ? features : [];
    let highestLevel = 0;
    let highestColor = '';
    let generalColor = '';

    for (let i = 0; i < list.length; i++) {
        const p = list[i].properties || {};
        const label = String(p.label || '').toUpperCase();
        const label2 = String(p.label2 || '').toUpperCase();
        const isGeneral = label === 'TSTM' || label2.indexOf('GENERAL THUNDER') !== -1;
        if (isGeneral && !generalColor) {
            generalColor = p.fill || p.stroke || '';
        }
        const level = _risk_level_for_props(p);
        if (level > highestLevel) {
            highestLevel = level;
            highestColor = p.fill || p.stroke || '';
        }
    }

    if (highestLevel > 0) {
        return {
            text: `Risk Level ${highestLevel}/5`,
            color: highestColor || 'rgba(255, 255, 255, 0.9)'
        };
    }
    if (_has_general_thunder(list)) {
        return {
            text: 'Risk Level: General Thunderstorms',
            color: generalColor || 'rgba(255, 255, 255, 0.9)'
        };
    }
    return {
        text: 'Risk Level: None',
        color: 'rgba(255, 255, 255, 0.9)'
    };
}

function _has_general_thunder(features) {
    const list = Array.isArray(features) ? features : [];
    for (let i = 0; i < list.length; i++) {
        const p = list[i].properties || {};
        const label = String(p.label || '').toUpperCase();
        const label2 = String(p.label2 || '').toUpperCase();
        if (label === 'TSTM' || label2.indexOf('GENERAL THUNDER') !== -1) return true;
    }
    return false;
}

function _render_header_risk_level(display) {
    const $risk = $('#spcOutlooksRiskLevel');
    if (!$risk.length) return;
    const next = display || {};
    $risk.text(next.text || 'Risk Level: --');
    $risk.css('color', next.color || 'rgba(255, 255, 255, 0.9)');
}

function _cache_categorical_risk_for_day(day, features) {
    const d = DAY_HAZARD_LAYER_IDS[day] ? day : _activeDay;
    _categoricalRiskByDay[d] = _risk_display_from_features(features);
    if (d === _activeDay) _render_header_risk_level(_categoricalRiskByDay[d]);
}

function _ensure_categorical_risk_for_day(day) {
    const d = DAY_HAZARD_LAYER_IDS[day] ? day : _activeDay;
    if (_categoricalRiskByDay[d]) {
        _render_header_risk_level(_categoricalRiskByDay[d]);
        return;
    }
    _render_header_risk_level({ text: 'Risk Level: --' });
    const layerId = _layer_id_for(d, 'categorical');
    fetch(_build_query_url(layerId), { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((geojson) => {
            const incoming = geojson && geojson.type === 'FeatureCollection'
                ? geojson
                : { type: 'FeatureCollection', features: [] };
            const normalized = (incoming.features || []).map((f) => ({
                type: f.type || 'Feature',
                geometry: f.geometry || null,
                properties: Object.assign({}, f.properties || {})
            }));
            _cache_categorical_risk_for_day(d, normalized);
        })
        .catch(() => {
            if (d === _activeDay) _render_header_risk_level({ text: 'Risk Level: --' });
        });
}

function _render_header_legend() {
    const $legend = $('#spcOutlooksHeaderLegend');
    if (!$legend.length) return;
    if (!_spcLegendItems.length) {
        $legend.html('');
        return;
    }
    let html = '';
    for (let i = 0; i < _spcLegendItems.length; i++) {
        const item = _spcLegendItems[i];
        const style = item.isHatched || item.isCig
            ? `background:transparent;border-color:${item.stroke};`
            : `background:${item.fill};border-color:${item.stroke};`;
        const hatchClass = item.isHatched
            ? ' spcOutlooksLegendSwatch-hatched'
            : (item.isCig ? ` spcOutlooksLegendSwatch-cig${item.cigLevel}` : '');
        html += '<div class="spcOutlooksLegendItem">' +
            `<span class="spcOutlooksLegendSwatch${hatchClass}" style="${style}"></span>` +
            `<span class="spcOutlooksLegendText">${item.label2}</span>` +
        '</div>';
    }
    $legend.html(html);
}

function _ensure_map_layers() {
    if (!_map || !_map.loaded()) return;

    if (!_map.getSource(SOURCE_ID)) {
        _map.addSource(SOURCE_ID, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
    }
    if (!_map.getSource(HATCH_SOURCE_ID)) {
        _map.addSource(HATCH_SOURCE_ID, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
    }

    if (!_map.getLayer(FILL_LAYER_ID)) {
        _map.addLayer({
            id: FILL_LAYER_ID,
            type: 'fill',
            source: SOURCE_ID,
            paint: {
                'fill-color': ['coalesce', ['get', 'fill'], '#8dc6ff'],
                'fill-opacity': 0
            }
        });
    }

    if (!_map.getLayer(LINE_LAYER_ID)) {
        _map.addLayer({
            id: LINE_LAYER_ID,
            type: 'line',
            source: HATCH_SOURCE_ID,
            paint: {
                'line-color': ['coalesce', ['get', 'stroke'], '#59a9ff'],
                'line-width': 0,
                'line-opacity': 0,
                'line-dasharray': [2, 1.5]
            }
        });
    }
}

function _set_active_button_group($buttons, attrName, value) {
    $buttons.removeClass('spcOutlooksBtn-active');
    $buttons.filter(`[${attrName}="${value}"]`).addClass('spcOutlooksBtn-active');
}

function _update_day3_hint() {
    const showHint = _activeDay === 'day3' && _activeHazard !== 'categorical';
    $('#spcOutlooksDay3Hint').toggleClass('spcOutlooksHint-visible', showHint);
}

function _update_header_title() {
    const dayLabel = _activeDay.replace('day', 'Day ');
    const hazardLabel = _activeHazard.charAt(0).toUpperCase() + _activeHazard.slice(1);
    $('#spcOutlooksHeaderTitle').text(`SPC Outlooks - ${dayLabel} | ${hazardLabel}`);
}

function _sync_button_state() {
    _set_active_button_group($('#spcOutlooksDayButtons .spcOutlooksBtn'), 'data-day', _activeDay);
    _set_active_button_group($('#spcOutlooksHazardButtons .spcOutlooksBtn'), 'data-hazard', _activeHazard);
    $('#spcOutlooksDrawToggle')
        .toggleClass('spcOutlooksMapToolBtn-active', _drawEnabled)
        .text(_drawEnabled ? 'Draw On' : 'Draw');
    _update_day3_hint();
    _update_header_title();
    _ensure_categorical_risk_for_day(_activeDay);
    _refresh_location_assessment_if_needed();
    _set_spc_share_url();
}

function _set_loading_state(isLoading) {
    _isLoading = isLoading;
    $('#spcOutlooksModal').toggleClass('spcOutlooksModal-loading', isLoading);
}

function _refresh_data() {
    if (!_map || !_map.loaded()) return;
    if (_isLoading) return;

    _set_loading_state(true);
    _set_empty_message('');

    const layerId = _layer_id_for(_activeDay, _activeHazard);
    fetch(_build_query_url(layerId), { cache: 'no-store' })
        .then((response) => {
            if (!response.ok) throw new Error(`SPC outlook fetch ${response.status}`);
            return response.json();
        })
        .then((geojson) => {
            const incoming = geojson && geojson.type === 'FeatureCollection'
                ? geojson
                : { type: 'FeatureCollection', features: [] };
            const normalizedFeatures = (incoming.features || []).map((feature) => {
                const props = Object.assign({}, feature.properties || {});
                props.spcIsHatched = _is_hatched_feature(props) ? 1 : 0;
                props.spcIsCig = _is_cig_feature(props) ? 1 : 0;
                props.spcCigLevel = props.spcIsCig ? _get_cig_level(props) : 0;
                return {
                    type: feature.type || 'Feature',
                    geometry: feature.geometry || null,
                    properties: props
                };
            });
            const cig = normalizedFeatures.filter((f) => f.properties && f.properties.spcIsCig === 1);
            const regular = normalizedFeatures.filter((f) => f.properties && f.properties.spcIsCig !== 1 && f.properties.spcIsHatched !== 1);
            const hatched = normalizedFeatures.filter((f) => f.properties && f.properties.spcIsCig !== 1 && f.properties.spcIsHatched === 1);
            _spcRegularFeatures = regular;
            _spcHatchedFeatures = hatched;
            _spcCigFeatures = cig;
            if (_activeHazard === 'categorical') _cache_categorical_risk_for_day(_activeDay, normalizedFeatures);
            _spcLegendItems = _build_legend_items(normalizedFeatures);
            _render_header_legend();
            const featureCollection = { type: 'FeatureCollection', features: normalizedFeatures };
            const regularSource = _map.getSource(SOURCE_ID);
            const hatchSource = _map.getSource(HATCH_SOURCE_ID);
            if (regularSource) regularSource.setData({ type: 'FeatureCollection', features: regular });
            if (hatchSource) hatchSource.setData({ type: 'FeatureCollection', features: hatched });
            _render_spc_overlay_canvas();
            _set_validity_panel(featureCollection);

            const featureCount = (featureCollection.features || []).length;
            if (featureCount === 0) {
                _set_empty_message('No polygons available for this selection right now.');
            } else {
                _set_empty_message('');
            }
        })
        .catch(() => {
            const source = _map.getSource(SOURCE_ID);
            const hatchSource = _map.getSource(HATCH_SOURCE_ID);
            if (source) source.setData({ type: 'FeatureCollection', features: [] });
            if (hatchSource) hatchSource.setData({ type: 'FeatureCollection', features: [] });
            _spcRegularFeatures = [];
            _spcHatchedFeatures = [];
            _spcCigFeatures = [];
            _spcLegendItems = [];
            _render_header_legend();
            if (_activeHazard === 'categorical') {
                delete _categoricalRiskByDay[_activeDay];
                _render_header_risk_level({ text: 'Risk Level: --' });
            }
            _render_spc_overlay_canvas();
            _set_validity_panel({ type: 'FeatureCollection', features: [] });
            _set_empty_message('Unable to load SPC outlook data. Please try again.');
        })
        .finally(() => {
            _set_loading_state(false);
        });
}

function _sync_draw_canvas_size() {
    if (!_map) return;
    const mapCanvas = _map.getCanvas();
    const dpr = window.devicePixelRatio || 1;
    const width = mapCanvas.clientWidth;
    const height = mapCanvas.clientHeight;

    if (_overlayCanvas) {
        _overlayCanvas.width = Math.max(1, Math.round(width * dpr));
        _overlayCanvas.height = Math.max(1, Math.round(height * dpr));
        _overlayCanvas.style.width = width + 'px';
        _overlayCanvas.style.height = height + 'px';
        _overlayCtx = _overlayCanvas.getContext('2d');
        _overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    if (!_drawCanvas) return;
    _drawCanvas.width = Math.max(1, Math.round(width * dpr));
    _drawCanvas.height = Math.max(1, Math.round(height * dpr));
    _drawCanvas.style.width = width + 'px';
    _drawCanvas.style.height = height + 'px';
    _drawCtx = _drawCanvas.getContext('2d');
    _drawCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    _drawCtx.lineJoin = 'round';
    _drawCtx.lineCap = 'round';
    _drawCtx.lineWidth = _get_main_draw_brush_size();
    _drawCtx.strokeStyle = '#ffffff';
    _fit_validity_text();
}

function _get_main_draw_brush_size() {
    try {
        const raw = localStorage.getItem(DRAW_SETTINGS_KEY);
        if (!raw) return 4;
        const parsed = JSON.parse(raw);
        const size = Number(parsed && parsed.brushSize);
        if (Number.isFinite(size) && size > 0) return size;
        return 4;
    } catch (_) {
        return 4;
    }
}

function _draw_polygon_ring(ctx, ringCoords) {
    if (!ringCoords || !ringCoords.length) return;
    for (let i = 0; i < ringCoords.length; i++) {
        const c = ringCoords[i];
        if (!Array.isArray(c) || c.length < 2) continue;
        const p = _map.project([c[0], c[1]]);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
}

function _draw_feature_path(ctx, feature) {
    const geom = feature && feature.geometry;
    if (!geom || !geom.type) return false;
    ctx.beginPath();
    if (geom.type === 'Polygon') {
        const rings = geom.coordinates || [];
        for (let i = 0; i < rings.length; i++) _draw_polygon_ring(ctx, rings[i]);
        return true;
    }
    if (geom.type === 'MultiPolygon') {
        const polys = geom.coordinates || [];
        for (let p = 0; p < polys.length; p++) {
            const rings = polys[p] || [];
            for (let i = 0; i < rings.length; i++) _draw_polygon_ring(ctx, rings[i]);
        }
        return true;
    }
    return false;
}

function _point_in_ring(lng, lat, ring) {
    let inside = false;
    if (!Array.isArray(ring) || ring.length < 3) return false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        const intersects = ((yi > lat) !== (yj > lat)) &&
            (lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi);
        if (intersects) inside = !inside;
    }
    return inside;
}

function _point_in_geometry(lng, lat, geometry) {
    if (!geometry || !geometry.type) return false;
    if (geometry.type === 'Polygon') {
        const rings = geometry.coordinates || [];
        if (!rings.length || !_point_in_ring(lng, lat, rings[0])) return false;
        for (let h = 1; h < rings.length; h++) {
            if (_point_in_ring(lng, lat, rings[h])) return false;
        }
        return true;
    }
    if (geometry.type === 'MultiPolygon') {
        const polys = geometry.coordinates || [];
        for (let p = 0; p < polys.length; p++) {
            if (_point_in_geometry(lng, lat, { type: 'Polygon', coordinates: polys[p] })) return true;
        }
    }
    return false;
}

function _mercator_from_lnglat(lng, lat) {
    const x = (lng + 180) / 360;
    const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const rad = clampedLat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
    return { x: x, y: y };
}

function _lnglat_from_mercator(x, y) {
    const lng = (x * 360) - 180;
    const n = Math.PI - (2 * Math.PI * y);
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return [lng, lat];
}

function _feature_world_bbox(feature) {
    if (!feature || !feature.geometry) return null;
    const geom = feature.geometry;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    function visitPoint(coord) {
        if (!Array.isArray(coord) || coord.length < 2) return;
        const m = _mercator_from_lnglat(coord[0], coord[1]);
        if (m.x < minX) minX = m.x;
        if (m.y < minY) minY = m.y;
        if (m.x > maxX) maxX = m.x;
        if (m.y > maxY) maxY = m.y;
    }

    if (geom.type === 'Polygon') {
        const rings = geom.coordinates || [];
        for (let r = 0; r < rings.length; r++) {
            const ring = rings[r] || [];
            for (let i = 0; i < ring.length; i++) visitPoint(ring[i]);
        }
    } else if (geom.type === 'MultiPolygon') {
        const polys = geom.coordinates || [];
        for (let p = 0; p < polys.length; p++) {
            const rings = polys[p] || [];
            for (let r = 0; r < rings.length; r++) {
                const ring = rings[r] || [];
                for (let i = 0; i < ring.length; i++) visitPoint(ring[i]);
            }
        }
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
}

function _collect_segment_points_for_line(box, family, c) {
    const pts = [];
    const eps = 1e-9;
    const minX = box.minX;
    const maxX = box.maxX;
    const minY = box.minY;
    const maxY = box.maxY;

    function pushIfInside(x, y) {
        if (x < minX - eps || x > maxX + eps || y < minY - eps || y > maxY + eps) return;
        for (let i = 0; i < pts.length; i++) {
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
    let a = pts[0];
    let b = pts[1];
    let bestDist = -1;
    for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
            const dx = pts[j].x - pts[i].x;
            const dy = pts[j].y - pts[i].y;
            const d = (dx * dx) + (dy * dy);
            if (d > bestDist) {
                bestDist = d;
                a = pts[i];
                b = pts[j];
            }
        }
    }
    return [a, b];
}

function _draw_cig_hatching(ctx, feature, strokeColor, cigLevel) {
    if (!ctx || !_overlayCanvas || !_map) return;
    const width = _overlayCanvas.clientWidth || _overlayCanvas.width || 0;
    const height = _overlayCanvas.clientHeight || _overlayCanvas.height || 0;
    if (width <= 0 || height <= 0) return;

    ctx.save();
    if (!_draw_feature_path(ctx, feature)) {
        ctx.restore();
        return;
    }
    ctx.clip('evenodd');

    const level = Number(cigLevel) || 1;
    const bbox = _feature_world_bbox(feature);
    if (!bbox) {
        ctx.restore();
        return;
    }

    const zoom = _map && typeof _map.getZoom === 'function' ? _map.getZoom() : 4.3;
    const zoomScale = Math.pow(2, zoom - 4.3);
    const worldPxAtBaseZoom = 512 * Math.pow(2, 4.3);

    function _stroke_hatch(family, baseSpacingPx, dashPatternPx) {
        const spacingWorld = (baseSpacingPx / worldPxAtBaseZoom) * Math.sqrt(2);
        const cMin = family === 'diag-pos'
            ? (bbox.minX + bbox.minY)
            : (bbox.minX - bbox.maxY);
        const cMax = family === 'diag-pos'
            ? (bbox.maxX + bbox.maxY)
            : (bbox.maxX - bbox.minY);
        const start = Math.floor(cMin / spacingWorld) * spacingWorld;
        const scaledDash = (dashPatternPx || []).map((n) => Math.max(2, Math.min(160, n * zoomScale)));

        ctx.beginPath();
        ctx.setLineDash(scaledDash);
        for (let c = start; c <= cMax + spacingWorld; c += spacingWorld) {
            const seg = _collect_segment_points_for_line(bbox, family, c);
            if (!seg) continue;
            const aLngLat = _lnglat_from_mercator(seg[0].x, seg[0].y);
            const bLngLat = _lnglat_from_mercator(seg[1].x, seg[1].y);
            const a = _map.project(aLngLat);
            const b = _map.project(bLngLat);
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
    ctx.setLineDash([]);
    ctx.restore();
}

function _fetch_day_hazard_features(day, hazard) {
    const key = `${day}|${hazard}`;
    if (_dayHazardFeatureCache[key]) return Promise.resolve(_dayHazardFeatureCache[key]);
    const layerId = _layer_id_for(day, hazard);
    return fetch(_build_query_url(layerId), { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { type: 'FeatureCollection', features: [] }))
        .then((geojson) => {
            const incoming = geojson && geojson.type === 'FeatureCollection'
                ? geojson
                : { type: 'FeatureCollection', features: [] };
            const normalized = (incoming.features || []).map((feature) => ({
                type: feature.type || 'Feature',
                geometry: feature.geometry || null,
                properties: Object.assign({}, feature.properties || {})
            }));
            _dayHazardFeatureCache[key] = normalized;
            return normalized;
        })
        .catch(() => []);
}

function _hazard_label(hazard) {
    if (hazard === 'tornado') return 'Tornado';
    if (hazard === 'hail') return 'Hail';
    if (hazard === 'wind') return 'Wind';
    return 'Categorical';
}

function _highest_feature_by_numeric_label(features) {
    let winner = null;
    let score = -1;
    for (let i = 0; i < features.length; i++) {
        const p = features[i].properties || {};
        const n = Number(p.label);
        const val = Number.isFinite(n) ? n : -1;
        if (val > score) {
            score = val;
            winner = features[i];
        }
    }
    return winner || features[0] || null;
}

function _prep_text_for_level(level, hazards) {
    const hz = hazards.length ? hazards.join(', ') : 'severe thunderstorms';
    if (level >= 4) return `High-end severe setup possible (${hz}). Have multiple warning methods, identify your shelter now, and be ready to act immediately.`;
    if (level === 3) return `Enhanced severe risk (${hz}). Review your safety plan, keep your phone charged, and stay close to trusted warnings today.`;
    if (level === 2) return `Slight severe risk (${hz}). Monitor forecast updates and have a quick shelter plan if warnings are issued.`;
    if (level === 1) return `Marginal severe risk (${hz}). Isolated severe storms are possible; keep an eye on radar and alerts.`;
    return 'No organized severe risk at this point. Keep normal weather awareness.';
}

function _render_location_assessment_loading(text) {
    $('#spcOutlooksLocationResult').html(
        '<div class="spcOutlooksSearchStatus">' + (text || 'Checking risk area...') + '</div>'
    );
}

function _render_location_assessment_error(text) {
    $('#spcOutlooksLocationResult').html(
        '<div class="spcOutlooksSearchError">' + (text || 'Unable to check this location right now.') + '</div>'
    );
}

function _render_location_assessment_result(locationName, categoricalDisplay, hazardRows, prepText, inRiskArea) {
    const hazardsText = hazardRows.length
        ? hazardRows.map((h) => `<li><strong>${h.name}:</strong> ${h.detail}</li>`).join('')
        : '<li>No tornado, hail, or wind severe probabilities at this point.</li>';
    const statusText = inRiskArea ? 'In risk area: Yes' : 'In risk area: No';
    const statusClass = inRiskArea ? 'spcOutlooksAssessYes' : 'spcOutlooksAssessNo';
    const riskColor = categoricalDisplay.color || 'rgba(255,255,255,0.9)';
    $('#spcOutlooksLocationResult').html(
        '<div class="spcOutlooksAssessCard">' +
            `<div class="spcOutlooksAssessPlace">${locationName}</div>` +
            `<div class="spcOutlooksAssessRisk" style="color:${riskColor}">${categoricalDisplay.text || 'Risk Level: --'}</div>` +
            `<div class="spcOutlooksAssessIn ${statusClass}">${statusText}</div>` +
            '<div class="spcOutlooksAssessLabel">Hazards</div>' +
            `<ul class="spcOutlooksAssessList">${hazardsText}</ul>` +
            '<div class="spcOutlooksAssessLabel">How To Prepare</div>' +
            `<div class="spcOutlooksAssessPrep">${prepText}</div>` +
        '</div>'
    );
}

function _run_location_assessment(lat, lon, locationName) {
    const hazards = ['categorical', 'tornado', 'hail', 'wind'];
    return Promise.all(hazards.map((hazard) => _fetch_day_hazard_features(_activeDay, hazard)))
        .then((sets) => {
            const byHazard = {};
            for (let i = 0; i < hazards.length; i++) {
                const all = sets[i] || [];
                byHazard[hazards[i]] = all.filter((f) => _point_in_geometry(lon, lat, f.geometry));
            }

            const categoricalInside = byHazard.categorical || [];
            const categoricalDisplay = _risk_display_from_features(categoricalInside);
            const level = _risk_level_from_features(categoricalInside);
            const inRiskArea = level > 0 || _has_general_thunder(categoricalInside);

            const hazardRows = [];
            const hazardNames = [];
            ['tornado', 'hail', 'wind'].forEach((hazard) => {
                const inside = (byHazard[hazard] || []).filter((f) => !_is_cig_feature(f.properties || {}));
                if (!inside.length) return;
                const feature = _highest_feature_by_numeric_label(inside);
                const p = (feature && feature.properties) || {};
                const name = _hazard_label(hazard);
                const detail = p.label2 || p.label || 'Risk';
                hazardRows.push({ name: name, detail: detail });
                hazardNames.push(name);
            });

            const prep = _prep_text_for_level(level, hazardNames);
            _render_location_assessment_result(locationName, categoricalDisplay, hazardRows, prep, inRiskArea);
        })
        .catch(() => {
            _render_location_assessment_error('Unable to analyze SPC risk for this location.');
        });
}

function _submit_location_search(lat, lon, name) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    _locationAssessLat = lat;
    _locationAssessLon = lon;
    _locationAssessName = name || `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
    $('#spcOutlooksLocationInput').val(_locationAssessName);
    $('#spcOutlooksLocationSuggestions').removeClass('spcOutlooksSuggestions-visible').html('');
    if (_map && window.mapboxgl) {
        if (!_locationMarker) {
            const markerEl = document.createElement('div');
            markerEl.className = 'spcOutlooksSearchPin';
            const markerImg = document.createElement('img');
            markerImg.className = 'spcOutlooksSearchPinImg';
            markerImg.alt = 'Location pin';
            markerImg.src = '/images/vortexicon_rotate.svg';
            markerImg.onerror = function() {
                markerEl.classList.add('spcOutlooksSearchPin-fallback');
                markerImg.remove();
            };
            markerEl.appendChild(markerImg);
            _locationMarker = new mapboxgl.Marker({ element: markerEl, anchor: 'bottom' });
        }
        _locationMarker.setLngLat([lon, lat]).addTo(_map);
    }
    _render_location_assessment_loading('Checking risk area...');
    _run_location_assessment(lat, lon, _locationAssessName);
}

function _refresh_location_assessment_if_needed() {
    if (!Number.isFinite(_locationAssessLat) || !Number.isFinite(_locationAssessLon)) return;
    _render_location_assessment_loading('Updating for selected day...');
    _run_location_assessment(_locationAssessLat, _locationAssessLon, _locationAssessName || 'Selected location');
}

function _on_location_search_input() {
    const $input = $('#spcOutlooksLocationInput');
    const $spinner = $('#spcOutlooksLocationSpinner');
    const $suggestions = $('#spcOutlooksLocationSuggestions');
    const query = ($input.val() || '').trim();
    if (_locationSearchDebounce) clearTimeout(_locationSearchDebounce);
    if (query.length < 2) {
        $suggestions.removeClass('spcOutlooksSuggestions-visible').html('');
        return;
    }
    $spinner.addClass('spcOutlooksSearchSpinner-active');
    _locationSearchDebounce = setTimeout(() => {
        _geocode_location(query, (err, results) => {
            $spinner.removeClass('spcOutlooksSearchSpinner-active');
            if (err || !results || !results.length) {
                $suggestions.removeClass('spcOutlooksSuggestions-visible').html('');
                return;
            }
            let html = '';
            for (let i = 0; i < results.length; i++) {
                const r = results[i];
                const name = _display_name_from_geocode(r).replace(/"/g, '&quot;');
                html += '<div class="spcOutlooksSuggestionItem" data-lat="' + r.lat + '" data-lon="' + r.lon + '" data-name="' + name + '">' + name + '</div>';
            }
            $suggestions.html(html).addClass('spcOutlooksSuggestions-visible');
        });
    }, 320);
}

function _on_location_search_keydown(e) {
    if (e.key !== 'Enter' && e.keyCode !== 13) return;
    e.preventDefault();
    const query = ($('#spcOutlooksLocationInput').val() || '').trim();
    if (!query) return;
    $('#spcOutlooksLocationSuggestions').removeClass('spcOutlooksSuggestions-visible').html('');
    $('#spcOutlooksLocationSpinner').addClass('spcOutlooksSearchSpinner-active');
    _geocode_location(query, (err, results) => {
        $('#spcOutlooksLocationSpinner').removeClass('spcOutlooksSearchSpinner-active');
        if (err || !results || !results.length) {
            _render_location_assessment_error('No location results found. Try another search.');
            return;
        }
        const first = results[0];
        _submit_location_search(parseFloat(first.lat), parseFloat(first.lon), _display_name_from_geocode(first));
    });
}

function _render_spc_overlay_canvas() {
    if (!_overlayCtx || !_overlayCanvas || !_map) return;
    _overlayCtx.clearRect(0, 0, _overlayCanvas.width, _overlayCanvas.height);

    for (let i = 0; i < _spcRegularFeatures.length; i++) {
        const feature = _spcRegularFeatures[i];
        const props = feature.properties || {};
        if (!_draw_feature_path(_overlayCtx, feature)) continue;
        _overlayCtx.fillStyle = props.fill || '#8dc6ff';
        _overlayCtx.globalAlpha = 0.75;
        _overlayCtx.fill('evenodd');
    }

    _overlayCtx.globalAlpha = 1;
    _overlayCtx.setLineDash([]);
    _overlayCtx.lineWidth = 2.4;
    for (let c = 0; c < _spcCigFeatures.length; c++) {
        const feature = _spcCigFeatures[c];
        const props = feature.properties || {};
        _draw_cig_hatching(_overlayCtx, feature, props.stroke || '#000000', props.spcCigLevel);
        if (!_draw_feature_path(_overlayCtx, feature)) continue;
        _overlayCtx.strokeStyle = props.stroke || '#000000';
        _overlayCtx.globalAlpha = 1;
        _overlayCtx.stroke();
    }

    _overlayCtx.globalAlpha = 1;
    _overlayCtx.setLineDash([5, 4]);
    _overlayCtx.lineWidth = 2.2;
    for (let j = 0; j < _spcHatchedFeatures.length; j++) {
        const feature = _spcHatchedFeatures[j];
        const props = feature.properties || {};
        if (!_draw_feature_path(_overlayCtx, feature)) continue;
        _overlayCtx.strokeStyle = props.stroke || '#59a9ff';
        _overlayCtx.stroke();
    }
    _overlayCtx.setLineDash([]);
}

function _clear_draw_layer() {
    if (!_drawCtx || !_drawCanvas) return;
    _drawCtx.clearRect(0, 0, _drawCanvas.width, _drawCanvas.height);
}

function _draw_pointer_down(e) {
    if (!_drawEnabled || !_drawCtx || !_drawCanvas) return;
    e.preventDefault();
    const rect = _drawCanvas.getBoundingClientRect();
    _drawLast = { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function _draw_pointer_move(e) {
    if (!_drawEnabled || !_drawCtx || !_drawCanvas || !_drawLast) return;
    e.preventDefault();
    const rect = _drawCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    _drawCtx.beginPath();
    _drawCtx.moveTo(_drawLast.x, _drawLast.y);
    _drawCtx.lineTo(x, y);
    _drawCtx.stroke();
    _drawLast = { x: x, y: y };
}

function _draw_pointer_up() {
    _drawLast = null;
}

function _set_draw_enabled(enabled) {
    _drawEnabled = !!enabled;
    if (_drawCanvas) _drawCanvas.style.pointerEvents = _drawEnabled ? 'auto' : 'none';
    _sync_button_state();
}

function _download_png(base64, prefix) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const link = document.createElement('a');
    link.download = (prefix || 'VortexRadar') + '_' + timestamp + '.png';
    link.href = 'data:image/png;base64,' + base64;
    document.body.appendChild(link);
    link.click();
    link.remove();
}

function _rounded_rect_path(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
}

function _draw_validity_card_on_export(ctx, mapCanvas) {
    const panel = document.getElementById('spcOutlooksValidity');
    if (!panel || !panel.classList.contains('spcOutlooksValidity-visible')) return;

    const mapRect = mapCanvas.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    const x = (panelRect.left - mapRect.left) * dpr;
    const y = (panelRect.top - mapRect.top) * dpr;
    const w = panelRect.width * dpr;
    const h = panelRect.height * dpr;

    const validFromDate = (document.getElementById('spcOutlooksValidFromDate') || {}).textContent || '--';
    const validFromTime = (document.getElementById('spcOutlooksValidFromTime') || {}).textContent || '--';
    const validUntilDate = (document.getElementById('spcOutlooksValidUntilDate') || {}).textContent || '--';
    const validUntilTime = (document.getElementById('spcOutlooksValidUntilTime') || {}).textContent || '--';

    ctx.save();

    _rounded_rect_path(ctx, x, y, w, h, 12 * dpr);
    ctx.fillStyle = 'rgba(4, 8, 16, 0.92)';
    ctx.fill();
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = 'rgba(14, 165, 233, 0.35)';
    ctx.stroke();

    const centerX = x + (w / 2);
    const top = y + (14 * dpr);
    ctx.textAlign = 'center';

    ctx.fillStyle = 'rgba(14, 165, 233, 0.95)';
    ctx.font = `800 ${11 * dpr}px Inter, Arial, sans-serif`;
    ctx.fillText('VALID FROM', centerX, top);

    ctx.fillStyle = '#ffffff';
    ctx.font = `800 ${18 * dpr}px Inter, Arial, sans-serif`;
    ctx.fillText(validFromDate, centerX, top + (24 * dpr));

    ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
    ctx.font = `600 ${13 * dpr}px Inter, Arial, sans-serif`;
    ctx.fillText(validFromTime, centerX, top + (44 * dpr));

    const dividerY = y + (h / 2);
    ctx.beginPath();
    ctx.moveTo(x + (20 * dpr), dividerY);
    ctx.lineTo(x + w - (20 * dpr), dividerY);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.38)';
    ctx.stroke();

    const lowerTop = dividerY + (18 * dpr);
    ctx.fillStyle = 'rgba(14, 165, 233, 0.95)';
    ctx.font = `800 ${11 * dpr}px Inter, Arial, sans-serif`;
    ctx.fillText('VALID UNTIL', centerX, lowerTop);

    ctx.fillStyle = '#ffffff';
    ctx.font = `800 ${18 * dpr}px Inter, Arial, sans-serif`;
    ctx.fillText(validUntilDate, centerX, lowerTop + (24 * dpr));

    ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
    ctx.font = `600 ${13 * dpr}px Inter, Arial, sans-serif`;
    ctx.fillText(validUntilTime, centerX, lowerTop + (44 * dpr));

    ctx.restore();
}

function _capture_spc_screenshot() {
    if (!_map) return;
    try {
        const mapCanvas = _map.getCanvas();
        const out = document.createElement('canvas');
        out.width = mapCanvas.width;
        out.height = mapCanvas.height;
        const ctx = out.getContext('2d');
        ctx.drawImage(mapCanvas, 0, 0);
        if (_overlayCanvas) ctx.drawImage(_overlayCanvas, 0, 0, mapCanvas.width, mapCanvas.height);
        if (_drawCanvas) ctx.drawImage(_drawCanvas, 0, 0, mapCanvas.width, mapCanvas.height);
        _draw_validity_card_on_export(ctx, mapCanvas);
        _download_png(out.toDataURL('image/png').split(',')[1], 'SPCOutlooks');
    } catch (_) {}
}

function _refresh_visible_spc() {
    if (!_overlay || !_overlay.hasClass('spcOutlooksOverlay-visible')) return;
    if (!_map || !_map.loaded()) return;
    _map.resize();
    _sync_draw_canvas_size();
    _sync_basemap_theme_from_main();
    _ensure_map_layers();
    _render_spc_overlay_canvas();
    _refresh_data();
}

function _clear_open_hydration_timers() {
    for (let i = 0; i < _openHydrationTimers.length; i++) {
        clearTimeout(_openHydrationTimers[i]);
    }
    _openHydrationTimers = [];
}

function _schedule_open_hydration() {
    _clear_open_hydration_timers();
    const delays = [40, 180, 420, 900, 1600, 2600, 4200, 6200];
    for (let i = 0; i < delays.length; i++) {
        const id = setTimeout(_refresh_visible_spc, delays[i]);
        _openHydrationTimers.push(id);
    }
}

function _build_overlay() {
    const html =
        '<div class="spcOutlooksOverlay" id="spcOutlooksOverlay">' +
            '<div class="spcOutlooksModal spcOutlooksModal-loading" id="spcOutlooksModal">' +
                '<div class="spcOutlooksHeader">' +
                    '<div class="spcOutlooksHeaderLeft">' +
                        '<span class="spcOutlooksHeaderTitle" id="spcOutlooksHeaderTitle">SPC Outlooks - Day 1 | Categorical</span>' +
                        '<span class="spcOutlooksHeaderSub" id="spcOutlooksHeaderSub">Last updated: --</span>' +
                    '</div>' +
                    '<div class="spcOutlooksHeaderCenter">' +
                        '<div class="spcOutlooksRiskLevel" id="spcOutlooksRiskLevel">Risk Level: --</div>' +
                        '<div class="spcOutlooksHeaderLegend" id="spcOutlooksHeaderLegend"></div>' +
                    '</div>' +
                    '<button type="button" class="spcOutlooksCloseBtn" id="spcOutlooksCloseBtn" aria-label="Close">Close</button>' +
                '</div>' +
                '<div class="spcOutlooksSidebar">' +
                    '<div class="spcOutlooksSectionLabel">Day</div>' +
                    '<div class="spcOutlooksButtonGroup" id="spcOutlooksDayButtons">' +
                        '<button type="button" class="spcOutlooksBtn spcOutlooksBtn-active" data-day="day1">Day 1</button>' +
                        '<button type="button" class="spcOutlooksBtn" data-day="day2">Day 2</button>' +
                        '<button type="button" class="spcOutlooksBtn" data-day="day3">Day 3</button>' +
                    '</div>' +
                    '<div class="spcOutlooksSectionLabel">Hazard</div>' +
                    '<div class="spcOutlooksButtonGroup" id="spcOutlooksHazardButtons">' +
                        '<button type="button" class="spcOutlooksBtn spcOutlooksBtn-active" data-hazard="categorical">Categorical</button>' +
                        '<button type="button" class="spcOutlooksBtn" data-hazard="hail">Hail</button>' +
                        '<button type="button" class="spcOutlooksBtn" data-hazard="wind">Wind</button>' +
                        '<button type="button" class="spcOutlooksBtn" data-hazard="tornado">Tornado</button>' +
                    '</div>' +
                    '<div class="spcOutlooksHint" id="spcOutlooksDay3Hint">Day 3 hazard selections map to SPC probabilistic severe outlook.</div>' +
                    '<div class="spcOutlooksDivider" aria-hidden="true"></div>' +
                    '<div class="spcOutlooksSectionLabel">Location Risk Search</div>' +
                    '<div class="spcOutlooksSearch">' +
                        '<i class="fa-solid fa-magnifying-glass spcOutlooksSearchIcon"></i>' +
                        '<div class="spcOutlooksSearchWrap">' +
                            '<input type="text" class="spcOutlooksSearchInput" id="spcOutlooksLocationInput" placeholder="Search city, state, or zip..." autocomplete="off">' +
                            '<div class="spcOutlooksSuggestions" id="spcOutlooksLocationSuggestions"></div>' +
                        '</div>' +
                        '<div class="spcOutlooksSearchSpinner" id="spcOutlooksLocationSpinner"></div>' +
                    '</div>' +
                    '<div class="spcOutlooksLocationResult" id="spcOutlooksLocationResult">' +
                        '<div class="spcOutlooksSearchStatus">Search a location to check risk, hazards, and preparation guidance.</div>' +
                    '</div>' +
                '</div>' +
                '<div class="spcOutlooksBody">' +
                    '<div class="spcOutlooksMapWrap">' +
                        '<div class="spcOutlooksMap" id="spcOutlooksMap"></div>' +
                        '<canvas class="spcOutlooksOverlayCanvas" id="spcOutlooksOverlayCanvas"></canvas>' +
                        '<canvas class="spcOutlooksDrawCanvas" id="spcOutlooksDrawCanvas"></canvas>' +
                        '<div class="spcOutlooksMapTools">' +
                            '<button type="button" class="spcOutlooksMapToolBtn" id="spcOutlooksScreenshotBtn">Screenshot</button>' +
                            '<button type="button" class="spcOutlooksMapToolBtn" id="spcOutlooksDrawToggle">Draw</button>' +
                            '<button type="button" class="spcOutlooksMapToolBtn" id="spcOutlooksDrawClearBtn">Clear</button>' +
                        '</div>' +
                        '<div class="spcOutlooksValidity" id="spcOutlooksValidity">' +
                            '<div class="spcOutlooksValidityLabel">Valid From</div>' +
                            '<div class="spcOutlooksValidityDate" id="spcOutlooksValidFromDate">--</div>' +
                            '<div class="spcOutlooksValidityTime" id="spcOutlooksValidFromTime">--</div>' +
                            '<div class="spcOutlooksValidityDivider"></div>' +
                            '<div class="spcOutlooksValidityLabel">Valid Until</div>' +
                            '<div class="spcOutlooksValidityDate" id="spcOutlooksValidUntilDate">--</div>' +
                            '<div class="spcOutlooksValidityTime" id="spcOutlooksValidUntilTime">--</div>' +
                        '</div>' +
                        '<div class="spcOutlooksEmpty" id="spcOutlooksEmpty"></div>' +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</div>';

    $('body').append(html);
    _overlay = $('#spcOutlooksOverlay');
    _overlayCanvas = document.getElementById('spcOutlooksOverlayCanvas');
    _drawCanvas = document.getElementById('spcOutlooksDrawCanvas');

    $('#spcOutlooksCloseBtn').on('click', _close);
    _overlay.on('click', function(e) {
        if ($(e.target).hasClass('spcOutlooksOverlay')) _close();
    });
    $('#spcOutlooksDayButtons').on('click', '.spcOutlooksBtn', function() {
        const nextDay = $(this).attr('data-day');
        if (!nextDay || nextDay === _activeDay) return;
        _activeDay = nextDay;
        _sync_button_state();
        _refresh_data();
    });
    $('#spcOutlooksHazardButtons').on('click', '.spcOutlooksBtn', function() {
        const nextHazard = $(this).attr('data-hazard');
        if (!nextHazard || nextHazard === _activeHazard) return;
        _activeHazard = nextHazard;
        _sync_button_state();
        _refresh_data();
    });
    $('#spcOutlooksScreenshotBtn').on('click', _capture_spc_screenshot);
    $('#spcOutlooksDrawToggle').on('click', function() { _set_draw_enabled(!_drawEnabled); });
    $('#spcOutlooksDrawClearBtn').on('click', _clear_draw_layer);
    $('#spcOutlooksLocationInput').on('input', _on_location_search_input);
    $('#spcOutlooksLocationInput').on('keydown', _on_location_search_keydown);
    $('#spcOutlooksLocationSuggestions').on('click', '.spcOutlooksSuggestionItem', function() {
        const lat = parseFloat($(this).attr('data-lat'));
        const lon = parseFloat($(this).attr('data-lon'));
        const name = $(this).attr('data-name') || '';
        _submit_location_search(lat, lon, name);
    });

    if (_drawCanvas) {
        _drawCanvas.addEventListener('pointerdown', _draw_pointer_down);
        _drawCanvas.addEventListener('pointermove', _draw_pointer_move);
        _drawCanvas.addEventListener('pointerup', _draw_pointer_up);
        _drawCanvas.addEventListener('pointerleave', _draw_pointer_up);
    }

    $(document).on('click', function(e) {
        if (!$(e.target).closest('.spcOutlooksSearchWrap').length) {
            $('#spcOutlooksLocationSuggestions').removeClass('spcOutlooksSuggestions-visible');
        }
    });
}

function _init_map() {
    if (_map) return;
    if (typeof mapboxgl === 'undefined') return;
    if (!mapboxgl.accessToken) mapboxgl.accessToken = MAPBOX_TOKEN;

    _map = new mapboxgl.Map({
        container: 'spcOutlooksMap',
        style: 'mapbox://styles/twalker92/cmd90758s006r01s2df82drgf',
        zoom: 4.3,
        center: [-98.5606744, 39.5],
        maxZoom: 20,
        preserveDrawingBuffer: true,
        maxPitch: 0,
        fadeDuration: 0,
        attributionControl: false,
        projection: 'mercator'
    });

    _map.touchZoomRotate.disableRotation();
    _map.dragRotate.disable();
    _map.keyboard.disableRotation();
    _map.on('load', function() {
        _sync_basemap_theme_from_main();
        _ensure_map_layers();
        _sync_draw_canvas_size();
        _render_spc_overlay_canvas();
        _refresh_data();
        setTimeout(_sync_basemap_theme_from_main, 180);
        setTimeout(_refresh_visible_spc, 250);
    });
    _map.on('resize', function() {
        _sync_draw_canvas_size();
        _render_spc_overlay_canvas();
    });
    _map.on('render', function() {
        if (!_overlay || !_overlay.hasClass('spcOutlooksOverlay-visible')) return;
        _render_spc_overlay_canvas();
    });
}

function _open() {
    _overlay.addClass('spcOutlooksOverlay-visible');
    _hide_global_corner_buttons();

    const shared = _read_spc_share_params();
    if (shared) {
        if (DAY_HAZARD_LAYER_IDS[shared.day]) _activeDay = shared.day;
        if (Object.prototype.hasOwnProperty.call(DAY_HAZARD_LAYER_IDS[_activeDay], shared.hazard)) _activeHazard = shared.hazard;
        _radarEnabled = !!shared.radar;
        _shareValidFromDate = shared.validFromDate || '';
        _shareValidUntilDate = shared.validUntilDate || '';
    }

    _sync_button_state();
    _schedule_open_hydration();

    if (!_map) {
        _init_map();
        return;
    }

    setTimeout(function() {
        _map.resize();
        _sync_draw_canvas_size();
        _sync_basemap_theme_from_main();
        _ensure_map_layers();
        _refresh_data();
        setTimeout(_sync_basemap_theme_from_main, 180);
    }, 20);
}

function _close() {
    _overlay.removeClass('spcOutlooksOverlay-visible');
    _clear_open_hydration_timers();
    _set_draw_enabled(false);
    _restore_global_corner_buttons();
    _clear_spc_share_url();
}

function init() {
    try {
        _mainMap = require('../core/map/map');
    } catch (_) {
        _mainMap = null;
    }
    _build_overlay();
    $('#armrSpcOutlooksBtn').on('click', function() { _open(); });
    if (_read_spc_share_params()) {
        let openedFromShare = false;
        const openFromShare = function() {
            if (openedFromShare) return;
            openedFromShare = true;
            _open();
            _schedule_open_hydration();
        };

        window.addEventListener('appBodyVisible', openFromShare, { once: true });
        window.addEventListener('load', openFromShare, { once: true });
        setTimeout(openFromShare, 1200);
        setTimeout(openFromShare, 2600);

        window.addEventListener('appBodyVisible', _refresh_visible_spc);
        window.addEventListener('load', _refresh_visible_spc);
    }
}

module.exports = { init: init };
