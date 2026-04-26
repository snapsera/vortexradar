const map = require('../core/map/map');

const DRAW_SETTINGS_KEY = 'vortexRadar_draw_settings';

const DEFAULTS = {
    color: '#ffffff',
    brushSize: 4,
    tool: 'pen'
};

function _load_settings() {
    try {
        const raw = localStorage.getItem(DRAW_SETTINGS_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                return Object.assign({}, DEFAULTS, parsed);
            }
        }
    } catch (_) {}
    return Object.assign({}, DEFAULTS);
}

function _save_settings(settings) {
    try {
        localStorage.setItem(DRAW_SETTINGS_KEY, JSON.stringify(settings));
    } catch (_) {}
}

let _canvas = null;
let _ctx = null;
let _drawing = false;
let _settings = _load_settings();
let _strokes = [];
let _currentStroke = null;

function _get_map_viewport_rect() {
    var mapElem = document.getElementById('map');
    if (!mapElem) {
        return {
            top: 0,
            left: 0,
            width: window.innerWidth,
            height: window.innerHeight
        };
    }
    var rect = mapElem.getBoundingClientRect();
    return {
        top: Math.max(0, rect.top),
        left: Math.max(0, rect.left),
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height)
    };
}

function _sync_canvas_to_map_viewport() {
    if (!_canvas) return;
    var rect = _get_map_viewport_rect();
    var dpr = window.devicePixelRatio || 1;

    _canvas.style.position = 'fixed';
    _canvas.style.top = rect.top + 'px';
    _canvas.style.left = rect.left + 'px';
    _canvas.style.width = rect.width + 'px';
    _canvas.style.height = rect.height + 'px';
    _canvas.style.zIndex = '999';
    _canvas.style.cursor = 'crosshair';
    _canvas.style.touchAction = 'none';

    _canvas.width = Math.round(rect.width * dpr);
    _canvas.height = Math.round(rect.height * dpr);

    _ctx = _canvas.getContext('2d');
    _ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    _redraw();
}

function _redraw() {
    if (!_ctx || !_canvas) return;
    var dpr = window.devicePixelRatio || 1;
    _ctx.save();
    _ctx.setTransform(1, 0, 0, 1, 0, 0);
    _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
    _ctx.restore();

    for (var i = 0; i < _strokes.length; i++) {
        _draw_stroke(_strokes[i]);
    }
    if (_currentStroke && _currentStroke.points.length > 0) {
        _draw_stroke(_currentStroke);
    }
}

function _draw_stroke(stroke) {
    if (!_ctx || !stroke.points || stroke.points.length === 0) return;
    _ctx.save();

    _ctx.lineCap = 'round';
    _ctx.lineJoin = 'round';

    if (stroke.tool === 'eraser') {
        _ctx.globalCompositeOperation = 'destination-out';
        _ctx.strokeStyle = 'rgba(0,0,0,1)';
        _ctx.lineWidth = stroke.size;
    } else {
        _ctx.globalCompositeOperation = 'source-over';
    }

    _ctx.beginPath();
    _ctx.moveTo(stroke.points[0].x, stroke.points[0].y);

    if (stroke.points.length === 1) {
        _ctx.lineTo(stroke.points[0].x + 0.1, stroke.points[0].y);
    } else {
        for (var i = 1; i < stroke.points.length; i++) {
            _ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
        }
    }

    if (stroke.tool !== 'eraser') {
        // Draw a stronger outline first so light colors stay visible on radar imagery.
        var outlineWidth = Math.max(2, stroke.size * 0.35);
        _ctx.strokeStyle = '#000000';
        _ctx.lineWidth = stroke.size + outlineWidth;
        _ctx.stroke();
    }

    _ctx.strokeStyle = stroke.tool === 'eraser' ? 'rgba(0,0,0,1)' : stroke.color;
    _ctx.lineWidth = stroke.size;
    _ctx.stroke();
    _ctx.restore();
}

function _get_canvas_point(e) {
    var rect = _canvas.getBoundingClientRect();
    return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
    };
}

function _on_pointerdown(e) {
    if (e.button !== 0) return;
    _drawing = true;
    _canvas.setPointerCapture(e.pointerId);

    var pt = _get_canvas_point(e);
    _currentStroke = {
        points: [pt],
        color: _settings.color,
        size: _settings.brushSize,
        tool: _settings.tool
    };
    _redraw();
}

function _on_pointermove(e) {
    if (!_drawing || !_currentStroke) return;
    var pt = _get_canvas_point(e);
    _currentStroke.points.push(pt);
    _redraw();
}

function _on_pointerup(e) {
    if (!_drawing) return;
    _drawing = false;
    if (_currentStroke && _currentStroke.points.length > 0) {
        _strokes.push(_currentStroke);
    }
    _currentStroke = null;
    _redraw();
}

function enable_drawing() {
    _settings = _load_settings();

    if (_canvas) {
        _canvas.remove();
        _canvas = null;
        _ctx = null;
    }

    _canvas = document.createElement('canvas');
    _canvas.id = 'draw_canvas';
    document.body.appendChild(_canvas);

    _sync_canvas_to_map_viewport();

    _canvas.addEventListener('pointerdown', _on_pointerdown);
    _canvas.addEventListener('pointermove', _on_pointermove);
    _canvas.addEventListener('pointerup', _on_pointerup);
    _canvas.addEventListener('pointercancel', _on_pointerup);

    map.boxZoom.disable();
    map.scrollZoom.disable();
    map.dragPan.disable();
    map.doubleClickZoom.disable();
    map.touchZoomRotate.disable();
    map.keyboard.disable();

    $(window).on('resize.drawMode', function () {
        _sync_canvas_to_map_viewport();
    });
}

function disable_drawing() {
    $(window).off('resize.drawMode');

    if (_canvas) {
        _canvas.removeEventListener('pointerdown', _on_pointerdown);
        _canvas.removeEventListener('pointermove', _on_pointermove);
        _canvas.removeEventListener('pointerup', _on_pointerup);
        _canvas.removeEventListener('pointercancel', _on_pointerup);
        _canvas.remove();
        _canvas = null;
        _ctx = null;
    }

    _strokes = [];
    _currentStroke = null;

    map.boxZoom.enable();
    map.scrollZoom.enable();
    map.dragPan.enable();
    map.doubleClickZoom.enable();
    map.touchZoomRotate.enable();
    map.keyboard.enable();
    map.keyboard.disableRotation();
}

function set_color(color) {
    _settings.color = color;
    _save_settings(_settings);
}

function set_brush_size(size) {
    _settings.brushSize = size;
    _save_settings(_settings);
}

function set_tool(tool) {
    _settings.tool = tool;
    _save_settings(_settings);
}

function clear_canvas() {
    _strokes = [];
    _currentStroke = null;
    _redraw();
}

function get_settings() {
    return Object.assign({}, _settings);
}

module.exports = {
    enable_drawing,
    disable_drawing,
    set_color,
    set_brush_size,
    set_tool,
    clear_canvas,
    get_settings
};
