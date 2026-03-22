const { plotToMap, TZ_LAYERS } = require('./plot_to_map');
const armFunctions = require('../core/menu/stormTrackProMenu');
const map = require('../core/map/map');

armFunctions.toggleswitchFunctions($('#armrTimezonesBtnSwitchElem'), function() {
    if (map.getLayer(TZ_LAYERS[0])) {
        for (var i = 0; i < TZ_LAYERS.length; i++) {
            map.setLayoutProperty(TZ_LAYERS[i], 'visibility', 'visible');
        }
    } else {
        plotToMap();
    }
}, function() {
    for (var i = 0; i < TZ_LAYERS.length; i++) {
        map.setLayoutProperty(TZ_LAYERS[i], 'visibility', 'none');
    }
});
