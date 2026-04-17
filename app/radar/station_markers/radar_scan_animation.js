const map = require('../../core/map/map');
const nexrad_locations = require('../libnexrad/nexrad_locations').NEXRAD_LOCATIONS;

var DEFAULT_SWEEP_PERIOD_MS = 20000;
var MIN_SWEEP_PERIOD_MS = 12000;
var MAX_SWEEP_PERIOD_MS = 8 * 60 * 1000;
var SWEEP_PERIOD_MS = DEFAULT_SWEEP_PERIOD_MS;
var DEG = 180 / Math.PI;
var EARTH_RADIUS_KM = 6371;

var TRAIL_DEG = 22;
var TRAIL_RAD = TRAIL_DEG * Math.PI / 180;
var NUM_ARCS = 14;
var INNER_GAP_PX = 14;
var MAX_CANVAS_DIM = 2048;

// Angular-fade mask: trail fades from transparent at the trailing edge to
// fully opaque at the leading edge, then a sharp cutoff past the leading edge.
// Leading edge sits at CSS 0° (top); trail extends 22° counter-clockwise (338°→360°).
var _MASK = 'conic-gradient(from ' + (360 - TRAIL_DEG) + 'deg at 50% 50%,' +
    'transparent 0deg,' +
    'rgba(255,255,255,0.01) 6deg,' +
    'rgba(255,255,255,0.04) 11deg,' +
    'rgba(255,255,255,0.14) 16deg,' +
    'rgba(255,255,255,0.40) 19deg,' +
    'rgba(255,255,255,0.75) 21deg,' +
    'white ' + TRAIL_DEG + 'deg,' +
    'white ' + (TRAIL_DEG + 0.3) + 'deg,' +
    'transparent ' + (TRAIL_DEG + 0.5) + 'deg,' +
    'transparent 360deg)';

var _currentStation = null;
var _sweepEnabled = false;
var _radarLat = 0;
var _radarLng = 0;
var _centerOverrideLat = null;
var _centerOverrideLng = null;
var _animationId = null;

var _container = null;
var _canvas = null;

var _cachedCx = 0;
var _cachedCy = 0;
var _cachedRadius = 0;
var _lastAppliedDiameter = 0;
var _cachedRect = null;
var _mapMoving = false;

function _get_pixel_radius() {
    var rangeKm = (window.stormTrackData && window.stormTrackData._radarMaxRangeKm) || 230;
    var deltaLat = (rangeKm / EARTH_RADIUS_KM) * DEG;
    var centerLat = (_centerOverrideLat != null) ? _centerOverrideLat : _radarLat;
    var centerLng = (_centerOverrideLng != null) ? _centerOverrideLng : _radarLng;
    var edgeLat = centerLat + deltaLat;
    var center = map.project([centerLng, centerLat]);
    var edge = map.project([centerLng, edgeLat]);
    return Math.abs(edge.y - center.y);
}

function _update_cached_rect() {
    _cachedRect = map.getContainer().getBoundingClientRect();
}

function _update_position() {
    if (!_cachedRect) _update_cached_rect();
    var centerLat = (_centerOverrideLat != null) ? _centerOverrideLat : _radarLat;
    var centerLng = (_centerOverrideLng != null) ? _centerOverrideLng : _radarLng;
    var screenPos = map.project([centerLng, centerLat]);
    _cachedCx = screenPos.x + _cachedRect.left;
    _cachedCy = screenPos.y + _cachedRect.top;
    _cachedRadius = _get_pixel_radius();

    var diameter = Math.ceil(_cachedRadius * 2);
    if (Math.abs(diameter - _lastAppliedDiameter) > 2) {
        _lastAppliedDiameter = diameter;
        if (_container) {
            _container.style.width = diameter + 'px';
            _container.style.height = diameter + 'px';
        }
        _draw_beam();
    }
}

function _draw_beam() {
    if (!_canvas) return;
    var isPreviewMode = !!(window?.stormTrackData?.radarPreviewMode);

    var diameter = _lastAppliedDiameter;
    if (diameter < 20) return;

    var dpr = window.devicePixelRatio || 1;
    var pixDiam = Math.min(Math.round(diameter * dpr), MAX_CANVAS_DIM);
    if (pixDiam < 20) return;

    _canvas.width = pixDiam;
    _canvas.height = pixDiam;

    var ctx = _canvas.getContext('2d');
    var s = pixDiam / diameter;
    var cx = pixDiam / 2;
    var cy = pixDiam / 2;
    var r = pixDiam / 2;
    var innerR = Math.max(INNER_GAP_PX * s, 4);

    var aLeading = -Math.PI / 2;
    var aTrailing = aLeading - TRAIL_RAD;

    ctx.clearRect(0, 0, pixDiam, pixDiam);

    // ---- Cone fill (radial gradient, angular fade handled by CSS mask) ----
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, innerR, aTrailing, aLeading);
    ctx.arc(cx, cy, r, aLeading, aTrailing, true);
    ctx.closePath();
    ctx.clip();

    var grad = ctx.createRadialGradient(cx, cy, innerR, cx, cy, r);
    if (isPreviewMode) {
        grad.addColorStop(0, 'rgba(210, 232, 248, 0.62)');
        grad.addColorStop(0.12, 'rgba(210, 232, 248, 0.44)');
        grad.addColorStop(0.30, 'rgba(210, 232, 248, 0.24)');
        grad.addColorStop(0.55, 'rgba(210, 232, 248, 0.12)');
        grad.addColorStop(0.80, 'rgba(210, 232, 248, 0.05)');
        grad.addColorStop(1, 'rgba(210, 232, 248, 0)');
    } else {
        grad.addColorStop(0, 'rgba(195, 215, 230, 0.26)');
        grad.addColorStop(0.12, 'rgba(195, 215, 230, 0.18)');
        grad.addColorStop(0.30, 'rgba(195, 215, 230, 0.10)');
        grad.addColorStop(0.55, 'rgba(195, 215, 230, 0.04)');
        grad.addColorStop(0.80, 'rgba(195, 215, 230, 0.01)');
        grad.addColorStop(1, 'rgba(195, 215, 230, 0)');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, pixDiam, pixDiam);
    ctx.restore();

    // ---- Concentric arcs ----
    var arcLw = Math.max(1, s);
    for (var i = 1; i <= NUM_ARCS; i++) {
        var t = i / (NUM_ARCS + 1);
        var arcR = innerR + (r - innerR) * t;
        var opacity = (isPreviewMode ? 0.36 : 0.20) * Math.pow(1 - t, 0.7);

        ctx.beginPath();
        ctx.arc(cx, cy, arcR, aTrailing, aLeading);
        ctx.strokeStyle = 'rgba(210, 230, 240, ' + opacity.toFixed(3) + ')';
        ctx.lineWidth = arcLw;
        ctx.stroke();
    }

    // ---- Beam line at leading edge ----
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy - innerR);
    ctx.lineTo(cx, cy - r);
    var lineGrad = ctx.createLinearGradient(cx, cy - innerR, cx, cy - r);
    if (isPreviewMode) {
        lineGrad.addColorStop(0, 'rgba(255, 255, 255, 0.92)');
        lineGrad.addColorStop(0.25, 'rgba(255, 255, 255, 0.55)');
        lineGrad.addColorStop(0.60, 'rgba(255, 255, 255, 0.18)');
    } else {
        lineGrad.addColorStop(0, 'rgba(255, 255, 255, 0.35)');
        lineGrad.addColorStop(0.25, 'rgba(255, 255, 255, 0.16)');
        lineGrad.addColorStop(0.60, 'rgba(255, 255, 255, 0.04)');
    }
    lineGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.strokeStyle = lineGrad;
    ctx.lineWidth = isPreviewMode ? Math.max(2.6, 2.6 * s) : Math.max(1.5, 1.5 * s);
    ctx.stroke();
    ctx.restore();
}

function _apply_transform() {
    if (!_container) return;
    var angleDeg = (performance.now() % SWEEP_PERIOD_MS) / SWEEP_PERIOD_MS * 360;
    var half = _lastAppliedDiameter / 2;
    _container.style.transform = 'translate3d(' + (_cachedCx - half) + 'px,' + (_cachedCy - half) + 'px,0) rotate(' + angleDeg + 'deg)';

    if (_cachedRadius < 10) {
        _container.style.opacity = '0';
    } else {
        _container.style.opacity = '1';
    }
}

function _create_elements() {
    if (_container) return;

    _container = document.createElement('div');
    _container.id = 'radarSweepContainer';
    var isPreviewMode = !!(window?.stormTrackData?.radarPreviewMode);
    _container.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:' + (isPreviewMode ? '99999' : '2') + ';will-change:transform;opacity:0;';
    if (isPreviewMode) {
        _container.style.mixBlendMode = 'screen';
        _container.style.filter = 'brightness(1.35) saturate(1.15)';
    }

    _canvas = document.createElement('canvas');
    _canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;' +
        '-webkit-mask-image:' + _MASK + ';' +
        'mask-image:' + _MASK + ';';

    _container.appendChild(_canvas);

    var parent = document.getElementById('bodyDiv') || document.body;
    parent.appendChild(_container);
}

function _remove_elements() {
    if (_container) {
        _container.remove();
        _container = null;
        _canvas = null;
    }
}

function _on_raf() {
    if (!_sweepEnabled) return;
    if (!_mapMoving) _apply_transform();
    _animationId = requestAnimationFrame(_on_raf);
}

function _on_map_render() {
    if (!_sweepEnabled || !_mapMoving) return;
    _update_position();
    _apply_transform();
}

function _on_move_start() {
    _mapMoving = true;
}

function _on_move_end() {
    _mapMoving = false;
    if (_sweepEnabled) _update_position();
}

function _on_zoom_end() {
    if (_sweepEnabled) _update_position();
}

function _on_resize() {
    _update_cached_rect();
    if (_sweepEnabled) _update_position();
}

function _bind_events() {
    map.on('render', _on_map_render);
    map.on('movestart', _on_move_start);
    map.on('moveend', _on_move_end);
    map.on('zoomend', _on_zoom_end);
    window.addEventListener('resize', _on_resize);
}

function _unbind_events() {
    map.off('render', _on_map_render);
    map.off('movestart', _on_move_start);
    map.off('moveend', _on_move_end);
    map.off('zoomend', _on_zoom_end);
    window.removeEventListener('resize', _on_resize);
}

function update(stationId) {
    if (!stationId || !nexrad_locations[stationId]) {
        remove();
        return;
    }

    var loc = nexrad_locations[stationId];
    _radarLat = loc.lat;
    _radarLng = loc.lon;

    if (_currentStation === stationId && _sweepEnabled) {
        _update_position();
        if (!_animationId) {
            _animationId = requestAnimationFrame(_on_raf);
        }
        return;
    }

    remove();
    _currentStation = stationId;
    _sweepEnabled = true;

    _create_elements();
    _update_cached_rect();
    _update_position();
    _apply_transform();
    _bind_events();
    _animationId = requestAnimationFrame(_on_raf);
}

function remove() {
    _sweepEnabled = false;
    _mapMoving = false;

    if (_animationId) {
        cancelAnimationFrame(_animationId);
        _animationId = null;
    }

    _unbind_events();
    _remove_elements();
    _currentStation = null;
    _centerOverrideLat = null;
    _centerOverrideLng = null;
    _lastAppliedDiameter = 0;
    _cachedRect = null;
}

function is_active() {
    return _sweepEnabled;
}

function get_current_station() {
    return _currentStation;
}

function set_center_override(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        _centerOverrideLat = null;
        _centerOverrideLng = null;
        return;
    }
    _centerOverrideLat = lat;
    _centerOverrideLng = lng;
    if (_sweepEnabled) _update_position();
}

function set_sweep_period_ms(ms) {
    if (!Number.isFinite(ms)) return;
    SWEEP_PERIOD_MS = Math.max(MIN_SWEEP_PERIOD_MS, Math.min(MAX_SWEEP_PERIOD_MS, Math.round(ms)));
}

function get_sweep_period_ms() {
    return SWEEP_PERIOD_MS;
}

module.exports = {
    update,
    remove,
    is_active,
    get_current_station,
    set_center_override,
    set_sweep_period_ms,
    get_sweep_period_ms
};
