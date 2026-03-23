const turf = require('@turf/turf');
const map = require('../core/map/map');
const ut = require('../core/utils');
const setLayerOrder = require('../core/map/setLayerOrder');
const luxon = require('luxon');
const icons = require('../core/map/icons/icons');
const filter_lightning = require('./filter_lightning');

const LIGHTNING_URL = `${ut.phpProxy}https://saratoga-weather.org/USA-blitzortung/placefile.txt`;
const REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const RETRY_DELAY_MS = 30 * 1000;
const MAX_STRIKE_AGE_MINUTES = 15;

var _refreshTimer = null;
var _retryTimer = null;
var _fetching = false;

function _parse_strikes(text) {
    var lines = text.split('\n');
    var points = [];

    for (var i = 0; i < lines.length; i++) {
        var row = lines[i];
        if (!row.startsWith('Icon:')) continue;

        try {
            row = row.replace('Icon: ', '').split(',');
            var lat = parseFloat(row[0]);
            var lng = parseFloat(row[1]);
            if (isNaN(lat) || isNaN(lng)) continue;

            var time = (row[5] || '').replace('Blitzortung @ ', '').slice(0, -4);
            if (!time) continue;

            var date = luxon.DateTime.fromFormat(time, 'h:mm:ssa', { zone: 'America/Los_Angeles' });
            if (!date.isValid) continue;

            var diff_minutes = luxon.DateTime.now().diff(date).as('minutes');
            if (diff_minutes <= MAX_STRIKE_AGE_MINUTES) {
                points.push(turf.point([lng, lat], { time: time, diff_minutes: diff_minutes }));
            }
        } catch (_) {
            // skip malformed line
        }
    }

    return turf.featureCollection(points);
}

function _fetch_lightning_data() {
    if (_fetching) return Promise.resolve(null);
    _fetching = true;

    return fetch(LIGHTNING_URL, {
        headers: { 'User-Agent': 'GR2Analyst' }
    })
    .then(function(response) {
        if (!response.ok) {
            throw new Error('Lightning fetch failed: HTTP ' + response.status);
        }
        return response.text();
    })
    .then(function(data) {
        _fetching = false;
        console.log('Fetched lightning data with a byte length of ' + ut.formatBytes(new Blob([data]).size) + '.');
        return _parse_strikes(data);
    })
    .catch(function(error) {
        _fetching = false;
        console.warn('[Lightning]', error.message || error);
        return null;
    });
}

function _update_source(collection) {
    if (!collection) return;

    window.stormTrackData.original_lightning_points = collection;

    if (map.getSource('lightningSource')) {
        map.getSource('lightningSource').setData(collection);
    } else {
        map.addSource('lightningSource', {
            type: 'geojson',
            data: collection
        });
    }
}

function _ensure_layer(callback) {
    if (map.getLayer('lightningLayer')) {
        setLayerOrder();
        if (callback) callback();
        return;
    }

    icons.add_icon_svg([
        [icons.icons.lightning_bolt_bold, 'lightning_bolt_bold']
    ], function() {
        if (map.getLayer('lightningLayer')) {
            setLayerOrder();
            if (callback) callback();
            return;
        }

        var calculate_opacity_level = function(decrease_rate) {
            return Array.from({ length: 5 }, function(_, i) { return 1 - i * decrease_rate; });
        };
        var levels = calculate_opacity_level(0.125);

        map.addLayer({
            id: 'lightningLayer',
            type: 'symbol',
            source: 'lightningSource',
            layout: {
                'icon-image': 'lightning_bolt_bold',
                'icon-size': [
                    'interpolate',
                    ['exponential', 0.2],
                    ['zoom'],
                    7, 0.2,
                    10, 0.23
                ],
                'icon-allow-overlap': false,
                'icon-padding': 0,
                'symbol-sort-key': ['get', 'diff_minutes'],
                'symbol-z-order': 'viewport-y'
            },
            paint: {
                'icon-opacity': [
                    'case',
                    ['<=', ['get', 'diff_minutes'], 3], levels[0],
                    ['<=', ['get', 'diff_minutes'], 6], levels[1],
                    ['<=', ['get', 'diff_minutes'], 9], levels[2],
                    ['<=', ['get', 'diff_minutes'], 12], levels[3],
                    ['<=', ['get', 'diff_minutes'], 15], levels[4],
                    levels[0],
                ],
            }
        });

        setLayerOrder();
        if (callback) callback();
    });
}

function _schedule_refresh() {
    _clear_timers();
    _refreshTimer = setInterval(function() {
        refresh();
    }, REFRESH_INTERVAL_MS);
}

function _schedule_retry() {
    if (_retryTimer) return;
    _retryTimer = setTimeout(function() {
        _retryTimer = null;
        refresh();
    }, RETRY_DELAY_MS);
}

function _clear_timers() {
    if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
    if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
}

function refresh() {
    _fetch_lightning_data().then(function(collection) {
        if (collection) {
            _update_source(collection);
            filter_lightning();
        } else {
            _schedule_retry();
        }
    });
}

function load_lightning(callback) {
    _fetch_lightning_data().then(function(collection) {
        if (collection) {
            _update_source(collection);
            _ensure_layer(callback);
            _schedule_refresh();
        } else {
            window.stormTrackData.original_lightning_points = turf.featureCollection([]);
            _update_source(turf.featureCollection([]));
            _ensure_layer(callback);
            _schedule_retry();
        }
    });
}

module.exports = load_lightning;
