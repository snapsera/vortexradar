const map = require('./map');
const set_layer_order = require('./setLayerOrder');
const map_funcs = require('./mapFunctions');

function change_map_style(style) {
    // const current_map_layers = map.getStyle().layers;
    // const original_sources = map.getStyle().sources;
    // const current_map_sources = Object.keys(original_sources).map(key => ({
    //     id: key,
    //     ...original_sources[key],
    // }));
    // const user_added_layers = current_map_layers.slice(1).slice(-(current_map_layers.length - window.stormTrackData.original_map_layers));
    // const user_added_sources = current_map_sources.slice(1).slice(-(current_map_sources.length - window.stormTrackData.original_map_sources));

    // if (style == 'satellite') {
    //     map.setStyle(base_url + 'satellite-streets-v12');
    // }

    // map.on('style.load', () => {
    //     for (var i = 0; i < user_added_sources.length; i++) {
    //         console.log(user_added_sources[i].id)
    //         map.addSource(user_added_sources[i].id, user_added_sources[i]);
    //     }
    //     for (var i = 0; i < user_added_layers.length; i++) {
    //         map.addLayer(user_added_layers[i]);
    //     }

    //     set_layer_order();
    // })

    if (window.stormTrackData.default_styles == undefined) {
        window.stormTrackData.default_styles = {
            'land': map.getLayer('land') ? map.getPaintProperty('land', 'background-color') : undefined,
            'national_park': map.getLayer('national-park') ? map.getPaintProperty('national-park', 'fill-color') : undefined,
            'landuse': map.getLayer('landuse') ? map.getPaintProperty('landuse', 'fill-color') : undefined,
            'water': map.getLayer('water') ? map.getPaintProperty('water', 'fill-color') : undefined,
        }
    }
    if (map.getLayer('usa-land-fill')) {
        map.removeLayer('usa-land-fill');
    }

    function _safePaint(layer, prop, value) {
        if (map.getLayer(layer)) map.setPaintProperty(layer, prop, value);
    }

    function set_dark() {
        _safePaint('land', 'background-color', '#2b3142');
        _safePaint('national-park', 'fill-color', '#2e3447');
        _safePaint('landuse', 'fill-color', '#2e3447');
        _safePaint('water', 'fill-color', '#141722');

        var darkHalo = 'rgba(27,30,43,0.8)';
        var labelColor = 'rgb(255, 255, 255)';
        _safePaint('state-label', 'text-color', labelColor);
        _safePaint('state-label', 'text-halo-color', darkHalo);
        _safePaint('country-label', 'text-color', labelColor);
        _safePaint('country-label', 'text-halo-color', darkHalo);
        _safePaint('settlement-major-label', 'text-color', labelColor);
        _safePaint('settlement-major-label', 'text-halo-color', darkHalo);
        _safePaint('settlement-minor-label', 'text-color', labelColor);
        _safePaint('settlement-minor-label', 'text-halo-color', darkHalo);
        _safePaint('settlement-subdivision-label', 'text-color', labelColor);
        _safePaint('settlement-subdivision-label', 'text-halo-color', darkHalo);
        _safePaint('water-point-label', 'text-color', '#4a5470');
        _safePaint('water-line-label', 'text-color', '#4a5470');
        _safePaint('road-label-simple', 'text-color', '#5a6378');

        _safePaint('admin-0-boundary', 'line-color', '#5c637d');
        _safePaint('admin-0-boundary-disputed', 'line-color', '#5c637d');
        _safePaint('admin-0-boundary-bg', 'line-color', '#454c63');
        _safePaint('admin-1-boundary', 'line-color', '#ffffff');
    }
    function set_light() {
        const white = 'rgb(246, 244, 237)';
        const blue = 'rgb(136, 190, 227)';

        _safePaint('land', 'background-color', white);
        _safePaint('national-park', 'fill-color', white);
        _safePaint('landuse', 'fill-color', white);
        _safePaint('water', 'fill-color', blue);

        var origHalo = 'rgba(255,255,255,0.75)';
        _safePaint('state-label', 'text-color', '#3d4554');
        _safePaint('state-label', 'text-halo-color', origHalo);
        _safePaint('country-label', 'text-color', '#3d4554');
        _safePaint('country-label', 'text-halo-color', origHalo);
        _safePaint('settlement-major-label', 'text-color', '#3d4554');
        _safePaint('settlement-major-label', 'text-halo-color', origHalo);
        _safePaint('settlement-minor-label', 'text-color', '#3d4554');
        _safePaint('settlement-minor-label', 'text-halo-color', origHalo);
        _safePaint('settlement-subdivision-label', 'text-color', '#3d4554');
        _safePaint('settlement-subdivision-label', 'text-halo-color', origHalo);
        _safePaint('water-point-label', 'text-color', '#4a6e8a');
        _safePaint('water-line-label', 'text-color', '#4a6e8a');
        _safePaint('road-label-simple', 'text-color', '#555e6e');

        _safePaint('admin-0-boundary', 'line-color', '#b0b8c4');
        _safePaint('admin-0-boundary-disputed', 'line-color', '#b0b8c4');
        _safePaint('admin-0-boundary-bg', 'line-color', '#c8ced6');
        _safePaint('admin-1-boundary', 'line-color', '#ffffff');
    }

    document.documentElement.dataset.mapTheme = style;

    if (style == 'satellite') {
        window.stormTrackData.map_type = 'satellite';

        set_dark();

        map.addSource('satellite-imagery', {
            'type': 'raster',
            'tiles': ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg'],
            'tileSize': 256,
            'maxzoom': 14,
            'attribution': 'EOxCloudless by EOX IT Services GmbH (modified Copernicus Sentinel data 2025)'
        });
        map.addLayer({ 'type': 'raster', 'id': 'satellite-map', 'source': 'satellite-imagery' }, map_funcs.get_base_layer());
    } else if (style == 'dark') {
        window.stormTrackData.map_type = 'dark';

        set_dark();

        if (map.getLayer('satellite-map')) {
            map.removeLayer('satellite-map');
            map.removeSource('satellite-imagery');
        }
    } else if (style == 'light') {
        window.stormTrackData.map_type = 'light';

        set_light();

        if (map.getLayer('satellite-map')) {
            map.removeLayer('satellite-map');
            map.removeSource('satellite-imagery');
        }
    }

    set_layer_order();
}

module.exports = change_map_style;
