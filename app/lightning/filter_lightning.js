const map = require('../core/map/map');
const turf = require('@turf/turf');
const NEXRAD_LOCATIONS = require('../radar/libnexrad/nexrad_locations').NEXRAD_LOCATIONS;

function filter_lightning(total_hide) {
    var original = window.stormTrackData && window.stormTrackData.original_lightning_points;
    if (!original || !original.features) {
        if (map.getSource('lightningSource')) {
            map.getSource('lightningSource').setData(turf.featureCollection([]));
        }
        return turf.featureCollection([]);
    }

    if (total_hide) {
        var empty = turf.featureCollection([]);
        if (map.getSource('lightningSource')) {
            map.getSource('lightningSource').setData(empty);
        }
        return empty;
    }

    var current_station = window.stormTrackData.currentStation;
    if (!current_station || !NEXRAD_LOCATIONS[current_station]) {
        if (map.getSource('lightningSource')) {
            map.getSource('lightningSource').setData(turf.featureCollection([]));
        }
        return turf.featureCollection([]);
    }

    var station_loc = NEXRAD_LOCATIONS[current_station];
    var station_point = turf.point([station_loc.lon, station_loc.lat]);
    var points = [];

    for (var i = 0; i < original.features.length; i++) {
        var feature = original.features[i];
        if (!feature || !feature.geometry || !feature.geometry.coordinates) continue;

        try {
            var point = turf.point(feature.geometry.coordinates, feature.properties);
            var distance = turf.distance(station_point, point, { units: 'kilometers' });
            if (distance <= 460) {
                points.push(point);
            }
        } catch (_) {
            // skip invalid feature
        }
    }

    var fc = turf.featureCollection(points);
    window.stormTrackData.station_lightning = fc;

    if (map.getSource('lightningSource')) {
        map.getSource('lightningSource').setData(fc);
    }
    return fc;
}

module.exports = filter_lightning;
