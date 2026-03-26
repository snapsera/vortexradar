const map = require('../core/map/map');
const settings_store = require('../core/menu/settings_store');

const surface_fronts_layers = [
    'fronts_layer',
    'pressure_points_layer',
    'front_symbols_layer',
];
window.stormTrackData.surface_fronts_layers = surface_fronts_layers;

const $surfaceFrontsSwitch = $('#armrSurfaceFrontsBtnSwitchElem');
$surfaceFrontsSwitch.prop('checked', false);
$surfaceFrontsSwitch.prop('disabled', true);

if (map.getLayer(surface_fronts_layers[0])) {
    for (var i = 0; i < surface_fronts_layers.length; i++) {
        map.setLayoutProperty(surface_fronts_layers[i], 'visibility', 'none');
    }
}

var _saved = settings_store.load();
if (_saved.surfaceFronts) {
    _saved.surfaceFronts = false;
    settings_store.save(_saved);
}