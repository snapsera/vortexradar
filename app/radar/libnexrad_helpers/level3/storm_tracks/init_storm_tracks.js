function _load_storm_track_product(product, callback) {
    var current_station = window.stormTrackData.currentStation;
    if (!current_station) {
        callback();
        return;
    }

    var loaders_nexrad = require('../../../libnexrad/loaders_nexrad');

    loaders_nexrad.get_latest_level_3_url(current_station, product, 0, function(url) {
        if (url == null) {
            if (product === 'NST') deal_with_storm_track_layers();
            if (product === 'NTV') deal_with_tvs_layers();
            callback();
            return;
        }

        loaders_nexrad.return_level_3_factory_from_url(url, function(L3Factory) {
            if (!L3Factory) {
                callback();
                return;
            }

            try {
                var desc_str = product === 'NTV' ? 'Tornado Vortex Signature:' : 'Storm Tracks:';

                if (L3Factory.get_file_age_in_minutes() > 30) {
                    if (product === 'NST') deal_with_storm_track_layers();
                    if (product === 'NTV') deal_with_tvs_layers();
                    callback();
                    return;
                }

                var file_id = L3Factory.generate_unique_id();

                if (product === 'NST' && window.stormTrackData.current_storm_track_id !== file_id) {
                    window.stormTrackData.current_storm_track_id = file_id;
                    deal_with_storm_track_layers();
                    console.log(desc_str, L3Factory);
                    L3Factory.plot();
                }

                if (product === 'NTV' && window.stormTrackData.current_tvs_id !== file_id) {
                    window.stormTrackData.current_tvs_id = file_id;
                    deal_with_tvs_layers();
                    console.log(desc_str, L3Factory);
                    L3Factory.plot();
                }
            } catch (e) {
                console.warn('[' + product + ']', e.message || e);
            }

            callback();
        });
    });
}

function deal_with_storm_track_layers() {
    var map = require('../../../../core/map/map');

    var storm_track_layers = window.stormTrackData.storm_track_layers;
    if (storm_track_layers != undefined) {
        for (var i in storm_track_layers) {
            try {
                if (map.getLayer(storm_track_layers[i])) { map.removeLayer(storm_track_layers[i]); }
                if (map.getSource(storm_track_layers[i])) { map.removeSource(storm_track_layers[i]); }
            } catch (_) {}
        }
    }
}

function deal_with_tvs_layers() {
    var map = require('../../../../core/map/map');

    var tvs_layers = window.stormTrackData.tvs_layers;
    if (tvs_layers != undefined) {
        for (var i in tvs_layers) {
            try {
                if (map.getLayer(tvs_layers[i])) { map.removeLayer(tvs_layers[i]); }
                if (map.getSource(tvs_layers[i])) { map.removeSource(tvs_layers[i]); }
            } catch (_) {}
        }
    }
}

function fetch_data() {
    _load_storm_track_product('NST', function() {
        _load_storm_track_product('NTV', function() {});
    });
}

module.exports = {
    fetch_data,
    deal_with_storm_track_layers,
    deal_with_tvs_layers
};
