var map = require('./map');
const map_funcs = require('./mapFunctions');

function move_layer_to_top(layer_name, before_layer = undefined) {
    if (map.getLayer(layer_name)) {
        if (before_layer == undefined) {
            map.moveLayer(layer_name);
        } else {
            map.moveLayer(layer_name, before_layer);
        }
    }
}

function setLayerOrder() {
    const before_layer = map_funcs.get_base_layer();

    // the circle range of the selected radar tower
    move_layer_to_top('station_range_layer', before_layer);

    // SPC Outlooks layers
    move_layer_to_top('spc_fill', before_layer);
    move_layer_to_top('spc_border', before_layer);

    // the main radar layer
    move_layer_to_top('baseReflectivity', before_layer);
    move_layer_to_top('nationalRadarLayer', before_layer);

    // lightning overlay
    move_layer_to_top('lightningGlow', before_layer);
    move_layer_to_top('lightningCore', before_layer);

    // timezone boundary layers
    move_layer_to_top('timezone_boundary_line', before_layer);
    move_layer_to_top('timezone_label_layer', before_layer);

    // weather radio layer
    move_layer_to_top('radioStationLayer');

    // discussions layers
    move_layer_to_top('discussions_layer_border');
    move_layer_to_top('discussions_layer');
    move_layer_to_top('discussions_layer_fill');

    // watches layers
    move_layer_to_top('watches_layer_border', before_layer);
    move_layer_to_top('watches_layer', before_layer);
    move_layer_to_top('watches_layer_fill', before_layer);

    // alerts layers
    move_layer_to_top('alertsLayerOutline', before_layer);
    move_layer_to_top('alertsLayer', before_layer);
    move_layer_to_top('alertsLayerFill', before_layer);

    // metar layer
    move_layer_to_top('metarSymbolLayer');

    // station marker layer
    move_layer_to_top('stationSymbolLayer');

    // hurricane layers
    const hurricane_layers = window.stormTrackData.hurricane_layers;
    if (hurricane_layers != undefined) {
        for (var i = 0; i < hurricane_layers.length; i++) {
            move_layer_to_top(hurricane_layers[i]);
        }
        for (var i = 0; i < hurricane_layers.length; i++) {
            if (hurricane_layers[i].includes('hurricane_outlook_point')) {
                move_layer_to_top(hurricane_layers[i]);
            }
        }
        for (var i = 0; i < hurricane_layers.length; i++) {
            if (!hurricane_layers[i].includes('outlook')) {
                move_layer_to_top(hurricane_layers[i]);
            }
        }
    }

    // surface fronts layers
    const surface_fronts_layers = window.stormTrackData.surface_fronts_layers;
    if (surface_fronts_layers != undefined) {
        for (var i = 0; i < surface_fronts_layers.length; i++) {
            move_layer_to_top(surface_fronts_layers[i]);
        }
        move_layer_to_top('pressure_points_layer');
    }
}

module.exports = setLayerOrder;