const ut = require('../core/utils');
const plot_alerts = require('./plot_alerts');
const pako = require('pako');
const combine_dictionary_data = require('./combine_dictionary_data');
const watch_overlay = require('./watch_overlay');

const fetch_discussions = require('./discussions/discussions');

const url_prefix = `${window.location.origin}/`;

const new_alerts_url = `https://preview.weather.gov/edd/resource/edd/hazards/getShortFusedHazards.php?all=true`;
const sws_alerts_url = `https://preview.weather.gov/edd/resource/edd/hazards/getSps.php`;
// https://realearth.ssec.wisc.edu/products/?app=_ALL_
const all_alerts_url = `https://realearth.ssec.wisc.edu/api/shapes?products=NWS-Alerts-All`;
const noaa_alerts_url = `https://api.weather.gov/alerts/active`;

// previously, these were written as:
// "../app/alerts/zones/forecast_zones.js.gz"
// but that didn't work when pushed to github pages
const zone_urls = [
    `${url_prefix}app/alerts/zones/forecast_zones.js.gz`,
    `${url_prefix}app/alerts/zones/county_zones.js.gz`,
    `${url_prefix}app/alerts/zones/fire_zones.js.gz`,
];

var headers = new Headers();
headers.append('User-Agent', '(Vortex Radar, https://vortexradar.snapsera.com)');
headers.append('Accept', 'application/geo+json');

function _wait_watch_overlay(alerts_data, done) {
    var finished = false;
    function finish() {
        if (finished) return;
        finished = true;
        done();
    }

    try {
        // watch overlay build can fetch many county/forecast zones; wait for it so
        // watches/county polygons are present before preload reveals the app.
        var maybePromise = watch_overlay.update_from_alerts_data(alerts_data);
        if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise.then(finish).catch(finish);
            setTimeout(finish, 8000);
            return;
        }
    } catch (_) {}
    finish();
}

function _fetch_alerts_data(callback) {
    fetch(noaa_alerts_url, {
        headers: headers
    })
    .then(response => {
        if (!response.ok) throw new Error(`Alerts API ${response.status}`);
        return response.json();
    })
    .then(alerts_data => {
        fetch_discussions();

        window.stormTrackData.alerts_data = alerts_data;
        $(document).trigger('alertsDataLoaded', [alerts_data]);
        _wait_watch_overlay(alerts_data, function() {
            callback(alerts_data);
        });
    })
    .catch(err => {
        console.error('Failed to fetch alerts:', err.message);
        callback({ features: [] });
    });
}

var byte_length = 0;
function _fetch_zone_dictionary(url) {
    return fetch(url)
        .then(response => response.arrayBuffer())
        .then(buffer => {
            return {
                byteLength: buffer.byteLength,
                scriptText: pako.inflate(buffer, { to: 'string' })
            };
        });
}

function _fetch_zone_dictionaries(callback) {
    byte_length = 0;
    Promise.all(zone_urls.map((url) => _fetch_zone_dictionary(url)))
    .then((results) => {
        for (var i = 0; i < results.length; i++) {
            byte_length += results[i].byteLength;
            var s = document.createElement('script');
            s.type = 'text/javascript';
            s.innerHTML = results[i].scriptText;
            document.head.appendChild(s);
        }
        console.log(`Loaded alert zone dictionaries with a size length of ${ut.formatBytes(byte_length)}.`);
        callback();
    })
    .catch((err) => {
        console.error('Failed to load zone dictionaries:', err);
        callback();
    });
}

function _fetch_data() {
    if (window.loaded_zones == undefined || window.loaded_zones == false) {
        window.loaded_zones = true;

        _fetch_alerts_data((alerts_data) => {
            window._zones_loaded = false;

            setTimeout(function() {
                if (!window._zones_loaded) {
                    plot_alerts(alerts_data);
                }
            }, 3000);

            _fetch_zone_dictionaries(() => {
                window._zones_loaded = true;
                const merged_geoJSON = combine_dictionary_data(alerts_data);
                plot_alerts(merged_geoJSON);
                window.dispatchEvent(new CustomEvent('alertsFullyReady'));
            });
        })
    } else {
        _fetch_alerts_data((alerts_data) => {
            const merged_geoJSON = combine_dictionary_data(alerts_data);
            plot_alerts(merged_geoJSON);
            window.dispatchEvent(new CustomEvent('alertsFullyReady'));
        })
    }
}

function return_data(callback) {
    fetch(noaa_alerts_url, {
        headers: headers
    })
    .then(response => {
        if (!response.ok) throw new Error(`Alerts API ${response.status}`);
        return response.json();
    })
    .then(alerts_data => {
        fetch_discussions();

        window.stormTrackData.alerts_data = alerts_data;
        $(document).trigger('alertsDataLoaded', [alerts_data]);
        _wait_watch_overlay(alerts_data, function() {
            callback(alerts_data);
        });
    })
    .catch(err => {
        console.error('Failed to fetch alerts:', err.message);
        callback({ features: [] });
    });
}

module.exports = {
    _fetch_data,
    return_data
}