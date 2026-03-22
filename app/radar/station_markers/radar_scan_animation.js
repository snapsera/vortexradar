const map = require('../../core/map/map');
const nexrad_locations = require('../libnexrad/nexrad_locations').NEXRAD_LOCATIONS;

var SWEEP_PERIOD_MS = 20000;
var TWO_PI = Math.PI * 2;
var DEG = 180 / Math.PI;
var EARTH_RADIUS_KM = 6371;

var _currentStation = null;
var _sweepEnabled = false;
var _radarLat = 0;
var _radarLng = 0;
var _animationId = null;

var _container = null;
var _trailEl = null;
var _beamEl = null;
var _dotEl = null;

var _cachedCx = 0;
var _cachedCy = 0;
var _cachedRadius = 0;
var _lastAppliedDiameter = 0;
var _cachedRect = null;
var _mapMoving = false;

function _get_pixel_radius() {
    var rangeKm = (window.stormTrackData && window.stormTrackData._radarMaxRangeKm) || 230;
    var deltaLat = (rangeKm / EARTH_RADIUS_KM) * DEG;
    var edgeLat = _radarLat + deltaLat;
    var center = map.project([_radarLng, _radarLat]);
    var edge = map.project([_radarLng, edgeLat]);
    return Math.abs(edge.y - center.y);
}

function _update_cached_rect() {
    _cachedRect = map.getContainer().getBoundingClientRect();
}

function _update_position() {
    if (!_cachedRect) _update_cached_rect();
    var screenPos = map.project([_radarLng, _radarLat]);
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
    }
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
    _container.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:2;will-change:transform;border-radius:50%;opacity:0;';

    _trailEl = document.createElement('div');
    _trailEl.style.cssText =
        'position:absolute;inset:0;border-radius:50%;' +
        'background:conic-gradient(from 353deg, transparent 0deg, rgba(255,255,255,0.14) 0.5deg, rgba(255,255,255,0.05) 4deg, transparent 7deg, transparent 360deg);' +
        '-webkit-mask-image:radial-gradient(circle, white 0%, transparent 70%);' +
        'mask-image:radial-gradient(circle, white 0%, transparent 70%);';

    _beamEl = document.createElement('div');
    _beamEl.style.cssText =
        'position:absolute;left:50%;bottom:50%;width:2px;height:50%;margin-left:-1px;' +
        'background:linear-gradient(to top, rgba(255,255,255,0.9), rgba(255,255,255,0.35) 40%, transparent);' +
        'transform-origin:bottom center;';

    _dotEl = document.createElement('div');
    _dotEl.style.cssText =
        'position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:rgba(255,255,255,0.7);';

    _container.appendChild(_trailEl);
    _container.appendChild(_beamEl);
    _container.appendChild(_dotEl);

    var parent = document.getElementById('bodyDiv') || document.body;
    parent.appendChild(_container);
}

function _remove_elements() {
    if (_container) {
        _container.remove();
        _container = null;
        _trailEl = null;
        _beamEl = null;
        _dotEl = null;
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
    _lastAppliedDiameter = 0;
    _cachedRect = null;
}

function is_active() {
    return _sweepEnabled;
}

function get_current_station() {
    return _currentStation;
}

module.exports = { update, remove, is_active, get_current_station, SWEEP_PERIOD_MS };
