const fetch_data = require('./fetch_data');
const armFunctions = require('../core/menu/vortexRadarMenu');
const map = require('../core/map/map');
const settings_store = require('../core/menu/settings_store');

const div_elem = '#surfaceFrontsMenuItemDiv';
const icon_elem = '#surfaceFrontsMenuItemIcon';

const surface_fronts_layers = [
    'fronts_layer',
    'pressure_points_layer',
    'front_symbols_layer',
];
window.stormTrackData.surface_fronts_layers = surface_fronts_layers;

armFunctions.toggleswitchFunctions($('#armrSurfaceFrontsBtnSwitchElem'), function() {
    if (map.getLayer(surface_fronts_layers[0])) {
        for (var i = 0; i < surface_fronts_layers.length; i++) {
            map.setLayoutProperty(surface_fronts_layers[i], 'visibility', 'visible');
        }
    } else {
        fetch_data();
    }
}, function() {
    for (var i = 0; i < surface_fronts_layers.length; i++) {
        map.setLayoutProperty(surface_fronts_layers[i], 'visibility', 'none');
    }
}, settings_store.saveFromDom);

var _saved = settings_store.load();
if (_saved.surfaceFronts) {
    $('#armrSurfaceFrontsBtnSwitchElem').prop('checked', true);
    fetch_data();
}