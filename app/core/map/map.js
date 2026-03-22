mapboxgl.accessToken = 'pk.eyJ1IjoidHdhbGtlcjkyIiwiYSI6ImNtZDkwaHMwdTAyazkya3BzNXphYWI3a2kifQ.sWYO653OYlYHYc_wOHsd2A';
const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/twalker92/cmd90758s006r01s2df82drgf',
    zoom: 4.3,
    center: [-98.5606744, 39.5],
    maxZoom: 20,
    preserveDrawingBuffer: true,
    maxPitch: 0,
    fadeDuration: 0,
    attributionControl: false,
    projection: 'mercator',
});

const ut = require('../utils');
ut.setMapMargin('bottom', 0, map);
ut.setMapMargin('top', $('#radarHeader').outerHeight() || 0, map);

$('#leftPanelToggle').on('click', function () {
    $('#leftPanel').toggleClass('leftPanel-closed leftPanel-open');
});

map.touchZoomRotate.disableRotation();
map.dragRotate.disable();
map.keyboard.disableRotation();
$('#map').on('contextmenu', function(e) {
    if ($(e.target).hasClass('mapboxgl-canvas')) {
        e.preventDefault();
    }
})

function _resize_map(reason) {
    map.resize();
    if (window.stormTrackData) {
        const perf = window.stormTrackData.perf = window.stormTrackData.perf || {};
        perf.mapResizeCalls = (perf.mapResizeCalls || 0) + 1;
        perf.mapResizeLastReason = reason;
    }
}

var _resize_raf_id = null;
function _throttled_resize(reason) {
    if (_resize_raf_id) return;
    _resize_raf_id = requestAnimationFrame(function() {
        _resize_raf_id = null;
        _resize_map(reason);
    });
}

window.onresize = () => { _throttled_resize('window-resize') }
window.addEventListener('appBodyVisible', () => { _resize_map('app-body-visible') });
map.on('load', () => { _resize_map('map-load') });

document.getElementById("texturecolorbar").width = 0;
document.getElementById("texturecolorbar").height = 0;

module.exports = map;
