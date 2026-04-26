const map = require('./map/map');

const el = document.getElementById('cursorCoords');
let _pendingLngLat = null;
let _cursorRaf = null;
let _lastCursorUpdateMs = 0;
const CURSOR_UPDATE_MIN_MS = 50;

function format(deg, posChar, negChar) {
    const abs = Math.abs(deg);
    const dir = deg >= 0 ? posChar : negChar;
    return abs.toFixed(4) + '° ' + dir;
}

function _flush_cursor_update() {
    _cursorRaf = null;
    if (!_pendingLngLat) return;
    const now = performance.now();
    if (now - _lastCursorUpdateMs < CURSOR_UPDATE_MIN_MS) {
        _cursorRaf = requestAnimationFrame(_flush_cursor_update);
        return;
    }
    _lastCursorUpdateMs = now;
    const { lng, lat } = _pendingLngLat;
    el.textContent = format(lat, 'N', 'S') + ',  ' + format(lng, 'E', 'W');
    el.classList.add('cursorCoords-visible');
    if (window?.stormTrackData) {
        const perf = window.stormTrackData.perf = window.stormTrackData.perf || {};
        perf.cursorCoordUpdates = (perf.cursorCoordUpdates || 0) + 1;
        perf.cursorCoordUpdateLastMs = _lastCursorUpdateMs;
    }
}

map.on('mousemove', function (e) {
    _pendingLngLat = e.lngLat;
    if (!_cursorRaf) {
        _cursorRaf = requestAnimationFrame(_flush_cursor_update);
    }
});

map.getCanvas().addEventListener('mouseleave', function () {
    el.classList.remove('cursorCoords-visible');
});
