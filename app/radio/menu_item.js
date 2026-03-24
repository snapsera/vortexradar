const plotToMap = require('./plot_to_map');
const armFunctions = require('../core/menu/vortexRadarMenu');
var map = require('../core/map/map');
const settings_store = require('../core/menu/settings_store');

armFunctions.toggleswitchFunctions($('#armrWeatherRadioBtnSwitchElem'), function() {
    if (map.getLayer('radioStationLayer')) {
        map.setLayoutProperty('radioStationLayer', 'visibility', 'visible');
    } else {
        plotToMap();
    }
}, function() {
    map.setLayoutProperty('radioStationLayer', 'visibility', 'none');
}, settings_store.saveFromDom);

var _saved = settings_store.load();
if (_saved.weatherRadio) {
    $('#armrWeatherRadioBtnSwitchElem').prop('checked', true);
    plotToMap();
}