const turf = require('@turf/turf');
const hash_string = require('./hash_string');

function _get_zone_dicts() {
    return {
        forecast: (typeof forecast_zones !== 'undefined' ? forecast_zones : ((typeof window !== 'undefined' && window.forecast_zones) ? window.forecast_zones : {})),
        county: (typeof county_zones !== 'undefined' ? county_zones : ((typeof window !== 'undefined' && window.county_zones) ? window.county_zones : {})),
        fire: (typeof fire_zones !== 'undefined' ? fire_zones : ((typeof window !== 'undefined' && window.fire_zones) ? window.fire_zones : {}))
    };
}

function merge_polygons(polygons) {
    // // const zs = ['MSZ001', 'MSZ007', 'MSZ008', 'MSZ010', 'MSZ011', 'MSZ012', 'MSZ020'];
    // const zs = ['PZZ252', 'PZZ253', 'PZZ272', 'PZZ273'];

    // const shapes = [];
    // for (var i = 0; i < zs.length; i++) {
    //     shapes.push(...turf.explode(forecast_zones[zs[i]]).features);
    // }

    // const fc = turf.featureCollection(shapes);
    // const outline = turf.convex(fc);

    // map.addLayer({
    //     'id': 'outline',
    //     'type': 'line',
    //     'source': {
    //         'type': 'geojson',
    //         'data': outline
    //     },
    //     'layout': {},
    //     'paint': {
    //         'line-color': '#0080ff',
    //         'line-width': 3
    //     }
    // });
    // return turf.featureCollection(polygons);

    const lookup = {};
    for (var i = 0; i < polygons.length; i++) {
        const properties = polygons[i].properties;
        const affected_zones = properties.affectedZones;

        const id = hash_string(JSON.stringify(properties));
        // var id = properties.parameters?.VTEC?.[0];
        // if (id == undefined) {
        //     id = properties.parameters?.WMOidentifier?.[0];
        // }

        lookup[id] = {
            'properties': properties,
            'affected_zones': affected_zones
        }
    }

    const outlines = [];
    const zoneDicts = _get_zone_dicts();
    const keys = Object.keys(lookup);
    for (var i = 0; i < keys.length; i++) {
        const shapes = [];
        const key = keys[i];
        const props = lookup[key].properties;
        const event = props?.event || '';
        const isWatch = event.endsWith('Watch') || event.includes(' Watch');

        const zs = lookup[key].affected_zones;
        // Watches should render from each zone directly (county/fire/forecast),
        // rather than a convex polygon.
        if (isWatch) {
            var watchZones;
            if (props.zone_type == 'forecast') { watchZones = zoneDicts.forecast }
            else if (props.zone_type == 'county') { watchZones = zoneDicts.county }
            else if (props.zone_type == 'fire') { watchZones = zoneDicts.fire }

            for (var w = 0; w < zs.length; w++) {
                if (watchZones && watchZones[zs[w]] != undefined) {
                    const zoneFeature = JSON.parse(JSON.stringify(watchZones[zs[w]]));
                    zoneFeature.properties = Object.assign({}, props, { affectedZones: [zs[w]] });
                    outlines.push(zoneFeature);
                }
            }
            continue;
        }

        for (var n = 0; n < zs.length; n++) {
            var zones;
            if (props.zone_type == 'forecast') { zones = zoneDicts.forecast }
            else if (props.zone_type == 'county') { zones = zoneDicts.county }
            else if (props.zone_type == 'fire') { zones = zoneDicts.fire }

            if (zones[zs[n]] != undefined) {
                const exploded = turf.explode(zones[zs[n]]).features;
                shapes.push(...exploded);
            }
        }
        if (shapes.length === 0) continue;
        const fc = turf.featureCollection(shapes);
        const outline = turf.convex(fc);
        if (!outline) continue;
        outline.properties = props;
        outlines.push(outline);

        // outline.properties.type = 'border';
        // outlines.push(JSON.parse(JSON.stringify(outline)));
        // outline.properties.type = 'outline';
        // outlines.push(JSON.parse(JSON.stringify(outline)));
    }

    const polygon_collection = turf.featureCollection(outlines);
    var duplicate_features = polygon_collection.features.flatMap((element) => [element, element]);
    duplicate_features = JSON.parse(JSON.stringify(duplicate_features));
    for (var i = 0; i < duplicate_features.length; i++) {
        if (i % 2 === 0) {
            duplicate_features[i].properties.type = 'border';
        } else {
            duplicate_features[i].properties.type = 'outline';
        }
    }
    polygon_collection.features = duplicate_features;

    return polygon_collection;
}

module.exports = merge_polygons;