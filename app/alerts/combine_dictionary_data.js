// const geojsonMerge = require('@mapbox/geojson-merge');
const turf = require('@turf/turf');
const map = require('../core/map/map');
const merge_polygons = require('./merge_polygons');

function _parse_zone_url(url) {
    if (url.includes('forecast')) {
        return { type: 'forecast', id: url.replace('https://api.weather.gov/zones/forecast/', '') };
    }
    if (url.includes('county')) {
        return { type: 'county', id: url.replace('https://api.weather.gov/zones/county/', '') };
    }
    if (url.includes('fire')) {
        return { type: 'fire', id: url.replace('https://api.weather.gov/zones/fire/', '') };
    }
    if (url.includes('marine')) {
        return { type: 'marine', id: url.replace('https://api.weather.gov/zones/marine/', '') };
    }
    return null;
}

function combine_dictionary_data(alerts_data) {
    const polygons = [];
    const zoneDicts = {
        forecast: (typeof forecast_zones !== 'undefined' ? forecast_zones : ((typeof window !== 'undefined' && window.forecast_zones) ? window.forecast_zones : {})),
        county: (typeof county_zones !== 'undefined' ? county_zones : ((typeof window !== 'undefined' && window.county_zones) ? window.county_zones : {})),
        fire: (typeof fire_zones !== 'undefined' ? fire_zones : ((typeof window !== 'undefined' && window.fire_zones) ? window.fire_zones : {}))
    };
    for (var item in alerts_data.features) {
        if (alerts_data.features[item].geometry == null) {
            var affectedZones = alerts_data.features[item].properties.affectedZones;
            var zonesByType = { forecast: [], county: [], fire: [] };
            for (var i in affectedZones) {
                var parsed = _parse_zone_url(affectedZones[i]);
                if (parsed && zonesByType[parsed.type]) {
                    var zones = zoneDicts[parsed.type];
                    if (zones[parsed.id] != undefined) {
                        zonesByType[parsed.type].push(parsed.id);
                    }
                }
            }
            // For watch events, prefer county zones only (watches are issued by county)
            const event = alerts_data.features[item].properties.event || '';
            const isWatch = event.endsWith('Watch') || event.includes(' Watch');
            const zoneTypesToUse = isWatch && zonesByType.county.length > 0
                ? ['county']
                : ['forecast', 'county', 'fire'];

            for (var zoneType of zoneTypesToUse) {
                var zoneIds = zonesByType[zoneType];
                if (zoneIds.length > 0) {
                    var zoneToPush = zoneDicts[zoneType][zoneIds[0]];
                    var props = Object.assign({}, alerts_data.features[item].properties, {
                        zone_type: zoneType,
                        affectedZones: zoneIds,
                        _zone_expanded: true
                    });
                    const polygon = turf.feature(zoneToPush.geometry, props);
                    polygons.push(polygon);
                    if (isWatch) break; // Only county for watches
                }
            }
        }
    }

    // const polygon_collection = turf.featureCollection(polygons);
    const polygon_collection = merge_polygons(polygons);

    var merged_geoJSON = geojson_merge([
        polygon_collection,
        alerts_data
    ]);
    return merged_geoJSON;
}

// https://github.com/mapbox/geojson-normalize/blob/master/index.js
var types = {
    Point: 'geometry',
    MultiPoint: 'geometry',
    LineString: 'geometry',
    MultiLineString: 'geometry',
    Polygon: 'geometry',
    MultiPolygon: 'geometry',
    GeometryCollection: 'geometry',
    Feature: 'feature',
    FeatureCollection: 'featurecollection'
};

/**
 * Normalize a GeoJSON feature into a FeatureCollection.
 *
 * @param {object} gj geojson data
 * @returns {object} normalized geojson data
 */
function normalize(gj) {
    if (!gj || !gj.type) return null;
    var type = types[gj.type];
    if (!type) return null;

    if (type === 'geometry') {
        return {
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                properties: {},
                geometry: gj
            }]
        };
    } else if (type === 'feature') {
        return {
            type: 'FeatureCollection',
            features: [gj]
        };
    } else if (type === 'featurecollection') {
        return gj;
    }
}

// https://github.com/mapbox/geojson-merge/blob/master/index.js#L22
function geojson_merge(inputs) {
    var output = {
        type: 'FeatureCollection',
        features: []
    };
    for (var i = 0; i < inputs.length; i++) {
        var normalized = normalize(inputs[i]);
        for (var j = 0; j < normalized.features.length; j++) {
            output.features.push(normalized.features[j]);
        }
    }
    return output;
}

module.exports = combine_dictionary_data;