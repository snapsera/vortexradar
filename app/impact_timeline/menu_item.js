const map = require('../core/map/map');
const turf = require('@turf/turf');
const get_polygon_colors = require('../alerts/colors/polygon_colors');

const icon_elem = '#impactTimelineMenuItemIcon';
const storage_key = 'vortexRadar_impactTimelineEnabled';
const source_id = 'impactTimelineMeasureSource';
const cone_fill_layer_id = 'impactTimelineConeFill';
const cone_outline_layer_id = 'impactTimelineConeOutline';
const center_line_layer_id = 'impactTimelineCenterLine';
const tick_line_layer_id = 'impactTimelineTickLines';
const point_layer_id = 'impactTimelineMeasurePoints';
const label_layer_id = 'impactTimelineMeasureLabels';

const DEFAULT_SPEED_MPH = 55;
const speed_storage_key = 'vortexRadar_distanceTrackerSpeedMph';

var _active = false;
var _dragging = false;
var _point_a = null;
var _point_b = null;
var _last_drag_lnglat = null;
var _manual_speed_mph = DEFAULT_SPEED_MPH;
var _auto_speed_mph = null;
var _auto_speed_event = '';

function _safe_load_enabled() {
    try {
        return localStorage.getItem(storage_key) === '1';
    } catch (_) {
        return false;
    }
}

function _save_enabled(enabled) {
    try {
        localStorage.setItem(storage_key, enabled ? '1' : '0');
    } catch (_) {}
}

function _load_manual_speed() {
    try {
        var raw = parseInt(localStorage.getItem(speed_storage_key), 10);
        if (Number.isFinite(raw) && raw >= 1 && raw <= 200) {
            return raw;
        }
    } catch (_) {}
    return DEFAULT_SPEED_MPH;
}

function _save_manual_speed(speed) {
    try {
        localStorage.setItem(speed_storage_key, String(speed));
    } catch (_) {}
}

function _effective_speed_mph() {
    return _auto_speed_mph || _manual_speed_mph || DEFAULT_SPEED_MPH;
}

function _clear_measure() {
    _point_a = null;
    _point_b = null;
    _dragging = false;
    _last_drag_lnglat = null;
    _auto_speed_mph = null;
    _auto_speed_event = '';
    _update_speed_ui();
    _sync_measure_layer_data();
}

function _format_eta_minutes(distance_miles, mph) {
    if (!Number.isFinite(distance_miles) || !Number.isFinite(mph) || mph <= 0) return '';
    return Math.round((distance_miles / mph) * 60) + ' min';
}

function _extract_moving_speed_mph(description) {
    if (!description || typeof description !== 'string') return null;

    var patterns = [
        /moving\s+[a-z\-\s]+?\s+at\s+(\d{1,3})\s*(mph|kt|kts|knot|knots)\b/i,
        /moving\s+at\s+(\d{1,3})\s*(mph|kt|kts|knot|knots)\b/i,
        /moving\s+[a-z\-\s]+?\s+(\d{1,3})\s*(mph|kt|kts|knot|knots)\b/i,
        /movement\s+.*?\b(\d{1,3})\s*(mph|kt|kts|knot|knots)\b/i,
        /storm\s+motion.*?\b(\d{1,3})\s*(mph|kt|kts|knot|knots)\b/i
    ];
    for (var i = 0; i < patterns.length; i++) {
        var m = description.match(patterns[i]);
        if (m && m[1]) {
            var mph = parseInt(m[1], 10);
            var unit = (m[2] || 'mph').toLowerCase();
            if (!Number.isFinite(mph)) continue;
            if (unit !== 'mph') mph = Math.round(mph * 1.15078);
            if (Number.isFinite(mph) && mph >= 1 && mph <= 200) return mph;
        }
    }
    return null;
}

function _extract_speed_from_parameters(parameters) {
    if (!parameters || typeof parameters !== 'object') return null;
    var keys = Object.keys(parameters);
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var lower = String(key || '').toLowerCase();
        if (lower.indexOf('motion') < 0 && lower.indexOf('moving') < 0 && lower.indexOf('speed') < 0) continue;
        var val = parameters[key];
        var str = Array.isArray(val) ? String(val[0] || '') : String(val || '');
        if (!str) continue;
        var byUnit = str.match(/(\d{1,3})\s*(mph|kt|kts|knot|knots)\b/i);
        if (byUnit) {
            var num = parseInt(byUnit[1], 10);
            var unit = byUnit[2].toLowerCase();
            if (!Number.isFinite(num)) continue;
            if (unit !== 'mph') num = Math.round(num * 1.15078);
            if (num >= 1 && num <= 200) return num;
        }
        var plain = str.match(/\b(\d{1,3})\b/);
        if (plain) {
            var mph = parseInt(plain[1], 10);
            if (Number.isFinite(mph) && mph >= 1 && mph <= 200) return mph;
        }
    }
    return null;
}

function _point_in_feature(point, feature) {
    if (!point || !feature || !feature.geometry) return false;
    try {
        return turf.booleanPointInPolygon(point, feature);
    } catch (_) {}
    try {
        var geom = feature.geometry;
        if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
            for (var i = 0; i < geom.geometries.length; i++) {
                var g = geom.geometries[i];
                if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
                if (turf.booleanPointInPolygon(point, turf.feature(g))) return true;
            }
        }
    } catch (_) {}
    return false;
}

function _warning_rank(event) {
    var e = String(event || '');
    if (e === 'Tornado Warning') return 1;
    if (e === 'Severe Thunderstorm Warning') return 2;
    if (e.indexOf('Warning') >= 0) return 3;
    return 9;
}

function _detect_auto_speed_for_point(pointLngLat) {
    var data = window.stormTrackData?.alerts_data;
    var features = Array.isArray(data?.features) ? data.features : [];
    if (!features.length) return null;

    var point = turf.point([pointLngLat.lng, pointLngLat.lat]);
    var best = null;

    for (var i = 0; i < features.length; i++) {
        var f = features[i];
        var props = f?.properties || {};
        var event = props.event || '';
        if (event.indexOf('Warning') < 0) continue;
        if (!f.geometry) continue;

        var inside = _point_in_feature(point, f);
        if (!inside) continue;

        var params = {};
        try {
            params = props.parameters
                ? (typeof props.parameters === 'string' ? JSON.parse(props.parameters) : props.parameters)
                : {};
        } catch (_) {
            params = {};
        }
        var speed = _extract_moving_speed_mph(props.description || '') || _extract_speed_from_parameters(params);
        if (!speed) continue;

        var gpc = get_polygon_colors(event) || {};
        var priority = parseInt(gpc.priority, 10);
        if (!Number.isFinite(priority)) priority = 999;
        var candidate = {
            speed: speed,
            event: event,
            rank: _warning_rank(event),
            priority: priority
        };
        if (!best) {
            best = candidate;
        } else if (
            candidate.rank < best.rank ||
            (candidate.rank === best.rank && candidate.priority < best.priority)
        ) {
            best = candidate;
        }
    }

    return best;
}

function _toolbar_html() {
    return '<div id="distanceTrackerToolbar" class="distanceTrackerToolbar">' +
        '<div class="distanceTrackerToolbarInner">' +
            '<div class="distanceTrackerToolbarLabel">Storm Speed</div>' +
            '<div class="distanceTrackerSpeedRow">' +
                '<input type="number" id="distanceTrackerSpeedInput" class="distanceTrackerSpeedInput" min="1" max="200" step="1" value="' + _manual_speed_mph + '">' +
                '<span class="distanceTrackerSpeedUnit">mph</span>' +
            '</div>' +
            '<div id="distanceTrackerSpeedSource" class="distanceTrackerSpeedSource">Manual speed</div>' +
            '<button type="button" id="distanceTrackerClearBtn" class="drawToolBtn" title="Clear measurement">' +
                '<i class="fa-solid fa-trash-can"></i>' +
            '</button>' +
        '</div>' +
    '</div>';
}

function _remove_toolbar() {
    var $tb = $('#distanceTrackerToolbar');
    if (!$tb.length) return;
    $tb.removeClass('distanceTrackerToolbar-visible').addClass('distanceTrackerToolbar-closing');
    setTimeout(function() { $tb.remove(); }, 220);
}

function _update_speed_ui() {
    var $input = $('#distanceTrackerSpeedInput');
    var $source = $('#distanceTrackerSpeedSource');
    if (!$input.length || !$source.length) return;

    $input.val(_manual_speed_mph);
    if (_auto_speed_mph) {
        $input.prop('disabled', true);
        $source.text('Auto: ' + _auto_speed_mph + ' mph from ' + _auto_speed_event);
    } else {
        $input.prop('disabled', false);
        $source.text('Manual: ' + _manual_speed_mph + ' mph');
    }
}

function _bind_toolbar() {
    $('#distanceTrackerSpeedInput').on('input change', function() {
        var parsed = parseInt($(this).val(), 10);
        if (!Number.isFinite(parsed)) return;
        parsed = Math.max(1, Math.min(200, parsed));
        _manual_speed_mph = parsed;
        _save_manual_speed(parsed);
        _update_speed_ui();
        if (!_auto_speed_mph) _sync_measure_layer_data();
    });

    $('#distanceTrackerClearBtn').on('click', function() {
        _clear_measure();
    });
}

function _position_toolbar() {
    var $tb = $('#distanceTrackerToolbar');
    var $anchor = $('#impactTimelineMenuItemDiv');
    if (!$tb.length || !$anchor.length) return;

    var rect = $anchor[0].getBoundingClientRect();
    var anchorCenterY = rect.top + (rect.height / 2);
    var rightFromViewport = Math.max(8, Math.round(window.innerWidth - rect.left + 10));

    $tb.css({
        top: Math.round(anchorCenterY) + 'px',
        right: rightFromViewport + 'px'
    });
}

function _build_measure_features() {
    var features = [];
    if (!_point_a) return features;

    features.push(turf.point([_point_a.lng, _point_a.lat], { role: 'origin' }));
    if (!_point_b) return features;

    var start = turf.point([_point_a.lng, _point_a.lat]);
    var end = turf.point([_point_b.lng, _point_b.lat]);
    var distance_miles = turf.distance(start, end, { units: 'miles' });
    if (!Number.isFinite(distance_miles) || distance_miles < 0.01) {
        features.push(turf.point([_point_b.lng, _point_b.lat], { role: 'target' }));
        return features;
    }

    var speed_mph = _effective_speed_mph();
    var half_angle_deg = 12;
    var angle_rad = half_angle_deg * Math.PI / 180;

    var pa = map.project([_point_a.lng, _point_a.lat]);
    var pb = map.project([_point_b.lng, _point_b.lat]);
    var vx = pb.x - pa.x;
    var vy = pb.y - pa.y;
    var px_len = Math.sqrt(vx * vx + vy * vy);
    if (!Number.isFinite(px_len) || px_len < 2) {
        features.push(turf.point([_point_b.lng, _point_b.lat], { role: 'target' }));
        return features;
    }
    var ux = vx / px_len;
    var uy = vy / px_len;
    var nx = -uy;
    var ny = ux;

    var end_half_width_px = Math.max(1, Math.tan(angle_rad) * px_len);
    var left_end_xy = { x: pb.x + nx * end_half_width_px, y: pb.y + ny * end_half_width_px };
    var right_end_xy = { x: pb.x - nx * end_half_width_px, y: pb.y - ny * end_half_width_px };
    var left_end_lnglat = map.unproject([left_end_xy.x, left_end_xy.y]);
    var right_end_lnglat = map.unproject([right_end_xy.x, right_end_xy.y]);

    var cone_bands = 10;
    for (var bi = 0; bi < cone_bands; bi++) {
        var t0 = bi / cone_bands;
        var t1 = (bi + 1) / cone_bands;
        var t0_safe = Math.max(0.001, t0);

        var c0x = pa.x + ux * px_len * t0_safe;
        var c0y = pa.y + uy * px_len * t0_safe;
        var c1x = pa.x + ux * px_len * t1;
        var c1y = pa.y + uy * px_len * t1;

        var w0 = Math.max(1, Math.tan(angle_rad) * px_len * t0_safe);
        var w1 = Math.max(1, Math.tan(angle_rad) * px_len * t1);

        var l0 = map.unproject([c0x + nx * w0, c0y + ny * w0]);
        var r0 = map.unproject([c0x - nx * w0, c0y - ny * w0]);
        var l1 = map.unproject([c1x + nx * w1, c1y + ny * w1]);
        var r1 = map.unproject([c1x - nx * w1, c1y - ny * w1]);

        var tm = (t0 + t1) * 0.5;
        var band_opacity = Math.max(0.02, 0.36 * Math.pow(1 - tm, 1.8));

        features.push(turf.polygon([[
            [l0.lng, l0.lat],
            [l1.lng, l1.lat],
            [r1.lng, r1.lat],
            [r0.lng, r0.lat],
            [l0.lng, l0.lat]
        ]], { role: 'cone_band', coneOpacity: band_opacity }));
    }

    // Side edges only (no hard end-cap line) to avoid a sharp cone cutoff.
    features.push(turf.lineString([
        [_point_a.lng, _point_a.lat],
        [left_end_lnglat.lng, left_end_lnglat.lat]
    ], { role: 'cone_edge' }));
    features.push(turf.lineString([
        [_point_a.lng, _point_a.lat],
        [right_end_lnglat.lng, right_end_lnglat.lat]
    ], { role: 'cone_edge' }));

    features.push(turf.lineString([
        [_point_a.lng, _point_a.lat],
        [_point_b.lng, _point_b.lat]
    ], { role: 'center' }));

    features.push(turf.point([_point_b.lng, _point_b.lat], { role: 'target' }));

    var step_miles = 5;
    if (distance_miles > 180) step_miles = 50;
    else if (distance_miles > 120) step_miles = 20;
    else if (distance_miles > 60) step_miles = 10;
    else if (distance_miles < 20) step_miles = 2;

    var tick_label_candidates = [];
    for (var d = step_miles; d < distance_miles; d += step_miles) {
        var t = d / distance_miles;
        var cx = pa.x + ux * px_len * t;
        var cy = pa.y + uy * px_len * t;
        var half_width_px = Math.max(1, Math.tan(angle_rad) * px_len * t);
        var left_xy = { x: cx + nx * half_width_px, y: cy + ny * half_width_px };
        var right_xy = { x: cx - nx * half_width_px, y: cy - ny * half_width_px };
        var left_ll = map.unproject([left_xy.x, left_xy.y]);
        var right_ll = map.unproject([right_xy.x, right_xy.y]);
        var center_ll = map.unproject([cx, cy]);

        features.push(turf.lineString([
            [left_ll.lng, left_ll.lat],
            [right_ll.lng, right_ll.lat]
        ], { role: 'tick' }));

        tick_label_candidates.push({
            coords: [center_ll.lng, center_ll.lat],
            label: Math.round(d) + ' mi\n' + _format_eta_minutes(d, speed_mph)
        });
    }

    var end_label = distance_miles.toFixed(1) + ' mi\n' + _format_eta_minutes(distance_miles, speed_mph);
    var end_coords = end.geometry.coordinates;
    var end_screen = null;
    try {
        end_screen = map.project(end_coords);
    } catch (_) {}

    for (var i = 0; i < tick_label_candidates.length; i++) {
        var candidate = tick_label_candidates[i];
        var keep = true;
        if (end_screen) {
            try {
                var p = map.project(candidate.coords);
                var dx = p.x - end_screen.x;
                var dy = p.y - end_screen.y;
                var screenDist = Math.sqrt(dx * dx + dy * dy);
                // Prevent stacked text at cone tip: endpoint label wins.
                if (screenDist < 44) keep = false;
            } catch (_) {}
        }
        if (keep) {
            features.push(turf.point(candidate.coords, {
                role: 'label',
                label: candidate.label
            }));
        }
    }

    features.push(turf.point(end_coords, {
        role: 'label',
        label: end_label
    }));

    return features;
}

function _ensure_measure_layers() {
    if (!map.getSource(source_id)) {
        map.addSource(source_id, {
            type: 'geojson',
            data: turf.featureCollection([])
        });
    }

    if (!map.getLayer(cone_fill_layer_id)) {
        map.addLayer({
            id: cone_fill_layer_id,
            type: 'fill',
            source: source_id,
            filter: ['==', ['get', 'role'], 'cone_band'],
            paint: {
                'fill-color': '#72b8ea',
                'fill-opacity': ['coalesce', ['get', 'coneOpacity'], 0.3]
            }
        });
    }

    if (!map.getLayer(cone_outline_layer_id)) {
        map.addLayer({
            id: cone_outline_layer_id,
            type: 'line',
            source: source_id,
            filter: ['==', ['get', 'role'], 'cone_edge'],
            paint: {
                'line-color': 'rgba(180, 220, 255, 0.5)',
                'line-width': 1.2
            }
        });
    }

    if (!map.getLayer(center_line_layer_id)) {
        map.addLayer({
            id: center_line_layer_id,
            type: 'line',
            source: source_id,
            filter: ['==', ['get', 'role'], 'center'],
            paint: {
                'line-color': '#8dd1ff',
                'line-width': 2,
                'line-opacity': 0.9
            }
        });
    }

    if (!map.getLayer(tick_line_layer_id)) {
        map.addLayer({
            id: tick_line_layer_id,
            type: 'line',
            source: source_id,
            filter: ['==', ['get', 'role'], 'tick'],
            paint: {
                'line-color': 'rgba(208, 235, 255, 0.65)',
                'line-width': 1.1
            }
        });
    }

    if (!map.getLayer(point_layer_id)) {
        map.addLayer({
            id: point_layer_id,
            type: 'circle',
            source: source_id,
            filter: ['in', ['get', 'role'], ['literal', ['origin', 'target']]],
            paint: {
                'circle-radius': 4.5,
                'circle-color': [
                    'match',
                    ['get', 'role'],
                    'origin', '#ffffff',
                    'target', '#d9ecff',
                    '#ffffff'
                ],
                'circle-stroke-width': 1.5,
                'circle-stroke-color': '#5aa6d8'
            }
        });
    }

    if (!map.getLayer(label_layer_id)) {
        map.addLayer({
            id: label_layer_id,
            type: 'symbol',
            source: source_id,
            filter: ['==', ['get', 'role'], 'label'],
            layout: {
                'text-field': ['get', 'label'],
                'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
                'text-size': 11,
                'text-line-height': 1.1,
                'text-anchor': 'center',
                'text-allow-overlap': true
            },
            paint: {
                'text-color': '#f3f9ff',
                'text-halo-color': 'rgba(8, 18, 28, 0.95)',
                'text-halo-width': 1.2
            }
        });
    }
}

function _remove_measure_layers() {
    if (map.getLayer(label_layer_id)) map.removeLayer(label_layer_id);
    if (map.getLayer(point_layer_id)) map.removeLayer(point_layer_id);
    if (map.getLayer(tick_line_layer_id)) map.removeLayer(tick_line_layer_id);
    if (map.getLayer(center_line_layer_id)) map.removeLayer(center_line_layer_id);
    if (map.getLayer(cone_outline_layer_id)) map.removeLayer(cone_outline_layer_id);
    if (map.getLayer(cone_fill_layer_id)) map.removeLayer(cone_fill_layer_id);
    if (map.getSource(source_id)) map.removeSource(source_id);
}

function _sync_measure_layer_data() {
    var src = map.getSource(source_id);
    if (!src) return;
    src.setData(turf.featureCollection(_build_measure_features()));
}

function _on_mouse_down(e) {
    if (!_active) return;
    if (_point_a && _point_b) return;
    _dragging = true;
    _last_drag_lnglat = e.lngLat;
    _point_a = { lng: e.lngLat.lng, lat: e.lngLat.lat };
    _point_b = { lng: e.lngLat.lng, lat: e.lngLat.lat };
    var auto = _detect_auto_speed_for_point(_point_a);
    _auto_speed_mph = auto?.speed || null;
    _auto_speed_event = auto?.event || '';
    _update_speed_ui();
    if (map.dragPan && map.dragPan.isEnabled()) {
        map.dragPan.disable();
    }
    _sync_measure_layer_data();
}

function _on_mouse_move(e) {
    if (!_active || !_dragging || !_point_a) return;
    _last_drag_lnglat = e.lngLat;
    _point_b = { lng: e.lngLat.lng, lat: e.lngLat.lat };
    _sync_measure_layer_data();
}

function _end_drag() {
    if (!_dragging) return;
    _dragging = false;
    if (map.dragPan && !map.dragPan.isEnabled()) {
        map.dragPan.enable();
    }
    _sync_measure_layer_data();
}

function _on_mouse_up(e) {
    if (!_active) return;
    if (_dragging && e && e.lngLat) {
        _point_b = { lng: e.lngLat.lng, lat: e.lngLat.lat };
    } else if (_dragging && _last_drag_lnglat) {
        _point_b = { lng: _last_drag_lnglat.lng, lat: _last_drag_lnglat.lat };
    }
    _end_drag();
}

function _on_window_mouseup() {
    if (!_active) return;
    _end_drag();
}

function _on_keydown(e) {
    if (e.key === 'Escape') _deactivate();
}

function _activate() {
    if (_active) return;
    _active = true;
    _save_enabled(true);
    _manual_speed_mph = _load_manual_speed();

    $(icon_elem).addClass('menu_item_selected').removeClass('menu_item_not_selected');

    if ($('#drawMenuItemIcon').hasClass('menu_item_selected')) $('#drawMenuItemIcon').click();
    if ($('#screenshotMenuItemIcon').hasClass('menu_item_selected')) $('#screenshotMenuItemIcon').click();
    if ($('#colorPickerItemClass').hasClass('menu_item_selected')) $('#colorPickerItemClass').click();

    _ensure_measure_layers();
    _sync_measure_layer_data();

    $('body').append(_toolbar_html());
    _position_toolbar();
    requestAnimationFrame(function() {
        $('#distanceTrackerToolbar').addClass('distanceTrackerToolbar-visible');
    });
    _bind_toolbar();
    _update_speed_ui();
    window.addEventListener('resize', _position_toolbar);

    map.on('mousedown', _on_mouse_down);
    map.on('mousemove', _on_mouse_move);
    map.on('mouseup', _on_mouse_up);
    window.addEventListener('mouseup', _on_window_mouseup);
    document.addEventListener('keydown', _on_keydown);
    map.getCanvas().style.cursor = 'crosshair';
}

function _deactivate() {
    if (!_active) return;
    _active = false;
    _save_enabled(false);
    _dragging = false;
    _last_drag_lnglat = null;

    $(icon_elem).removeClass('menu_item_selected').addClass('menu_item_not_selected');
    map.off('mousedown', _on_mouse_down);
    map.off('mousemove', _on_mouse_move);
    map.off('mouseup', _on_mouse_up);
    window.removeEventListener('mouseup', _on_window_mouseup);
    document.removeEventListener('keydown', _on_keydown);
    if (map.dragPan && !map.dragPan.isEnabled()) {
        map.dragPan.enable();
    }
    map.getCanvas().style.cursor = '';
    window.removeEventListener('resize', _position_toolbar);

    _remove_toolbar();
    _clear_measure();
    _remove_measure_layers();
}

function _toggle() {
    if (_active) _deactivate();
    else _activate();
}

$(icon_elem).on('click', _toggle);

window.addEventListener('stormTrackModulesLoaded', function() {
    if (_safe_load_enabled()) _activate();
});

module.exports = { activate: _activate, deactivate: _deactivate, toggle: _toggle };
