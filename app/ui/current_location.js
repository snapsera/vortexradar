const map = require('../core/map/map');
const setLayerOrder = require('../core/map/setLayerOrder');
const notificationBubble = require('../core/notifications/notification_bubble');

const SOURCE_ID = 'currentLocationSource';
const OUTER_LAYER_ID = 'currentLocationOuterLayer';
const RING_LAYER_ID = 'currentLocationRingLayer';
const CORE_LAYER_ID = 'currentLocationCoreLayer';
const ACCEPTABLE_ACCURACY_M = 150;
const MAX_WAIT_MS = 14000;
const MAX_RESULT_AGE_MS = 2 * 60 * 1000;

let _isLocating = false;

function _setLocatingState(isLocating) {
    _isLocating = isLocating;
    const btn = document.getElementById('currentLocationBtn');
    const icon = document.getElementById('currentLocationIcon');
    if (!btn || !icon) return;

    if (isLocating) {
        btn.classList.add('is-locating');
        icon.classList.add('fa-spin');
        btn.title = 'Getting your location...';
    } else {
        btn.classList.remove('is-locating');
        icon.classList.remove('fa-spin');
        btn.title = 'Use current location';
    }
}

function _createPoint(lng, lat) {
    return {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [lng, lat]
            },
            properties: {}
        }]
    };
}

function _ensureLayers(pointData) {
    if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, {
            type: 'geojson',
            data: pointData
        });
    } else {
        map.getSource(SOURCE_ID).setData(pointData);
    }

    if (!map.getLayer(OUTER_LAYER_ID)) {
        map.addLayer({
            id: OUTER_LAYER_ID,
            type: 'circle',
            source: SOURCE_ID,
            paint: {
                'circle-radius': 12,
                'circle-color': '#38bdf8',
                'circle-opacity': 0.22
            }
        });
    }

    if (!map.getLayer(RING_LAYER_ID)) {
        map.addLayer({
            id: RING_LAYER_ID,
            type: 'circle',
            source: SOURCE_ID,
            paint: {
                'circle-radius': 7,
                'circle-color': '#38bdf8',
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 1.5,
                'circle-opacity': 0.95
            }
        });
    }

    if (!map.getLayer(CORE_LAYER_ID)) {
        map.addLayer({
            id: CORE_LAYER_ID,
            type: 'circle',
            source: SOURCE_ID,
            paint: {
                'circle-radius': 2.5,
                'circle-color': '#ffffff',
                'circle-opacity': 1
            }
        });
    }

    // Keep location layers above dynamic overlays.
    setLayerOrder();
    if (map.getLayer(OUTER_LAYER_ID)) map.moveLayer(OUTER_LAYER_ID);
    if (map.getLayer(RING_LAYER_ID)) map.moveLayer(RING_LAYER_ID);
    if (map.getLayer(CORE_LAYER_ID)) map.moveLayer(CORE_LAYER_ID);
}

function _applyLocationPosition(position) {
    const lat = Number(position && position.coords && position.coords.latitude);
    const lng = Number(position && position.coords && position.coords.longitude);
    const accuracyM = Math.round(Number(position && position.coords && position.coords.accuracy) || 0);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        notificationBubble.notify('Unable to read your device location.', {
            icon: 'fa fa-circle-exclamation',
            level: 'warning'
        });
        return;
    }

    _ensureLayers(_createPoint(lng, lat));
    map.flyTo({
        center: [lng, lat],
        zoom: Math.max(10, map.getZoom()),
        speed: 1.35,
        essential: true
    });

    const accuracyText = accuracyM > 0 ? ' (accuracy ±' + accuracyM + 'm)' : '';
    notificationBubble.notify('Centered map on your current location' + accuracyText + '.', {
        icon: 'fa fa-location-dot',
        level: 'success'
    });
}

function _get_fresh_location(onSuccess, onError) {
    let watchId = null;
    let finished = false;
    let bestPosition = null;
    let bestAccuracy = Number.POSITIVE_INFINITY;
    let lastError = null;
    const startedAt = Date.now();

    function finishWithPosition(position) {
        if (finished) return;
        finished = true;
        if (watchId !== null) navigator.geolocation.clearWatch(watchId);
        clearTimeout(hardTimeout);
        onSuccess(position);
    }

    function finishWithError(err) {
        if (finished) return;
        finished = true;
        if (watchId !== null) navigator.geolocation.clearWatch(watchId);
        clearTimeout(hardTimeout);
        onError(err);
    }

    const hardTimeout = setTimeout(function() {
        if (bestPosition) {
            finishWithPosition(bestPosition);
            return;
        }
        finishWithError(lastError || { code: 3 });
    }, MAX_WAIT_MS);

    watchId = navigator.geolocation.watchPosition(function(position) {
        const lat = Number(position && position.coords && position.coords.latitude);
        const lng = Number(position && position.coords && position.coords.longitude);
        const accuracy = Number(position && position.coords && position.coords.accuracy);
        const fixTimestamp = Number(position && position.timestamp) || Date.now();
        const ageMs = Date.now() - fixTimestamp;

        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(accuracy)) return;

        if (accuracy < bestAccuracy) {
            bestPosition = position;
            bestAccuracy = accuracy;
        }

        const waitedMs = Date.now() - startedAt;
        const freshEnough = ageMs <= MAX_RESULT_AGE_MS;
        const accurateEnough = accuracy <= ACCEPTABLE_ACCURACY_M;
        if (freshEnough && accurateEnough) {
            finishWithPosition(position);
            return;
        }

        if (waitedMs >= MAX_WAIT_MS - 1000 && bestPosition) {
            finishWithPosition(bestPosition);
        }
    }, function(err) {
        lastError = err || { code: 2 };
    }, {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
    });
}

function _handleLocationClick() {
    if (_isLocating) return;

    if (!navigator.geolocation) {
        notificationBubble.notify('Geolocation is not supported by this browser.', {
            icon: 'fa fa-circle-exclamation',
            level: 'warning'
        });
        return;
    }

    _setLocatingState(true);
    _get_fresh_location(function(position) {
        _setLocatingState(false);
        _applyLocationPosition(position);
    }, function(err) {
        _setLocatingState(false);
        let msg = 'Unable to get your location.';
        if (err && err.code === 1) msg = 'Location permission was denied.';
        if (err && err.code === 2) msg = 'Location is unavailable right now.';
        if (err && err.code === 3) msg = 'Location request timed out.';
        notificationBubble.notify(msg, {
            icon: 'fa fa-circle-exclamation',
            level: 'warning'
        });
    });
}

function init() {
    const btn = document.getElementById('currentLocationBtn');
    if (!btn) return;
    btn.addEventListener('click', _handleLocationClick);
}

module.exports = { init };
