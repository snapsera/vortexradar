const plot_to_map = require('./plot_to_map');
const product_colors = require('../colormaps/colormaps');
const ut = require('../../core/utils')
const chroma = require('chroma-js');
const work = require('webworkify');

function deg2rad(angle) { return angle * (Math.PI / 180) }

var _persistent_worker = null;
var _worker_callback_queue = [];
var _chroma_scale_cache = {};
var _dealias_toggle_cache = {
    region: null,
    tornadic: null
};

function _get_worker() {
    if (!_persistent_worker) {
        _persistent_worker = work(require('./calculation_worker'));
        _persistent_worker.addEventListener('message', function(ev) {
            var cb = _worker_callback_queue.shift();
            if (cb) cb(ev.data);
        });
    }
    return _persistent_worker;
}

function _get_checkbox_checked(id, cacheKey) {
    var cached = _dealias_toggle_cache[cacheKey];
    if (cached == null || !document.body.contains(cached)) {
        cached = document.getElementById(id);
        _dealias_toggle_cache[cacheKey] = cached;
    }
    return !!(cached && cached.checked);
}

function _to_float32(arr) {
    if (arr instanceof Float32Array) return arr;
    var len = arr ? arr.length : 0;
    var out = new Float32Array(len);
    for (var i = 0; i < len; i++) out[i] = arr[i];
    return out;
}

function _flatten_data_grid(data, numAz, numRanges) {
    var flatData = new Float32Array(numAz * numRanges);
    for (var i = 0; i < numAz; i++) {
        var row = data[i];
        var base = i * numRanges;
        for (var n = 0; n < numRanges; n++) {
            flatData[base + n] = (row && row[n] !== null && row[n] !== undefined) ? row[n] : NaN;
        }
    }
    return flatData;
}

function calculate_coordinates(nexrad_factory, options) {
    const start = Date.now();

    var product;
    var elevation;
    if (nexrad_factory.nexrad_level == 2) {
        product = options.product;
        elevation = options.elevation;
        window.stormTrackData.product_code = product;
    } else if (nexrad_factory.nexrad_level == 3) {
        product = nexrad_factory.product_abbv;
        window.stormTrackData.product_code = nexrad_factory.product_code;
    }
    window.stormTrackData.product = product;

    const dealias_mode_region_based = _get_checkbox_checked('armrDealiasRegionBasedBtnSwitchElem', 'region');
    const dealias_mode_tornadic = _get_checkbox_checked('armrDealiasTornadicBtnSwitchElem', 'tornadic');

    var should_plot_dealiased;
    if (nexrad_factory.nexrad_level == 2 && product == 'VEL') {
        should_plot_dealiased = window.stormTrackData.should_plot_dealiased;

        if (dealias_mode_tornadic) {
            if (should_plot_dealiased) {
                nexrad_factory.dealias_alt_and_plot(elevation - 1, () => {});
                return;
            }
        }
        if (dealias_mode_region_based) {
            var already_dealiased = nexrad_factory.check_if_already_dealiased(elevation);
            if (should_plot_dealiased && !already_dealiased) {
                nexrad_factory.dealias(elevation);
            }
        }
    }

    var azimuths = nexrad_factory.get_azimuth_angles(elevation);
    var ranges = nexrad_factory.get_ranges(product, elevation);
    var data;
    if (nexrad_factory.nexrad_level == 2) {
        data = nexrad_factory.get_data(product, elevation, should_plot_dealiased);
    } else {
        data = nexrad_factory.get_data(product, elevation);
    }

    var location = nexrad_factory.get_location();
    var radar_lat_lng = {'lat': location[0], 'lng': location[1]};
    var radar_lat = deg2rad(radar_lat_lng.lat);
    var radar_lng = deg2rad(radar_lat_lng.lng);

    var color_data = product_colors[product];
    var chroma_scale = _chroma_scale_cache[product];
    if (!chroma_scale) {
        var values = [...color_data.values];
        values = ut.scaleValues(values, product);
        chroma_scale = chroma.scale(color_data.colors).domain(values).mode('lab');
        _chroma_scale_cache[product] = chroma_scale;
    }
    window.stormTrackData.webgl_chroma_scale = chroma_scale;

    var numAz = azimuths.length;
    var numRanges = ranges.length;
    var azF32 = _to_float32(azimuths);
    var rangesF32 = _to_float32(ranges);
    var flatData = _flatten_data_grid(data, numAz, numRanges);

    var w = _get_worker();
    _worker_callback_queue.push(function(result) {
        console.log(`Calculated vertices in ${Date.now() - start} ms`);
        plot_to_map(result.vertices, result.colors, product, nexrad_factory);
    });
    w.postMessage({
        mode: 'build_and_project',
        azimuths: azF32,
        ranges: rangesF32,
        data: flatData,
        dataWidth: numRanges,
        lngLat: radar_lat_lng
    }, [azF32.buffer, rangesF32.buffer, flatData.buffer]);
}

function precompute_render_data(nexrad_factory, callback) {
    var product = nexrad_factory.product_abbv;
    var azimuths = nexrad_factory.get_azimuth_angles();
    var ranges = nexrad_factory.get_ranges();
    var data = nexrad_factory.get_data();
    var location = nexrad_factory.get_location();
    var radar_lat_lng = { 'lat': location[0], 'lng': location[1] };

    var numAz = azimuths.length;
    var numRanges = ranges.length;
    var azF32 = _to_float32(azimuths);
    var rangesF32 = _to_float32(ranges);
    var flatData = _flatten_data_grid(data, numAz, numRanges);

    var w = _get_worker();
    _worker_callback_queue.push(function(result) {
        callback({ vertices: result.vertices, colors: result.colors, product: product });
    });
    w.postMessage({
        mode: 'build_and_project',
        azimuths: azF32,
        ranges: rangesF32,
        data: flatData,
        dataWidth: numRanges,
        lngLat: radar_lat_lng
    }, [azF32.buffer, rangesF32.buffer, flatData.buffer]);
}

module.exports = calculate_coordinates;
module.exports.precompute_render_data = precompute_render_data;