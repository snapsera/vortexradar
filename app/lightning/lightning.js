const map = require('../core/map/map');
const map_funcs = require('../core/map/mapFunctions');
const setLayerOrder = require('../core/map/setLayerOrder');

const LAYER_GLOW = 'lightningGlow';
const LAYER_CORE = 'lightningCore';
const SOURCE_ID = 'lightningSource';
const LAYERS = [LAYER_GLOW, LAYER_CORE];

const STRIKE_LIFETIME_MS = 6000;
const ANIMATION_INTERVAL_MS = 75;
const WS_RECONNECT_DELAY_MS = 5000;
const WS_URLS = [
    'wss://ws1.blitzortung.org/',
    'wss://ws7.blitzortung.org/',
    'wss://ws8.blitzortung.org/',
];

var strikes = [];
var ws = null;
var animationTimer = null;
var active = false;
var wsUrlIndex = 0;
var reconnectTimeout = null;

function createLayers() {
    if (map.getSource(SOURCE_ID)) return;

    map.addSource(SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
    });

    map.addLayer({
        id: LAYER_GLOW,
        type: 'circle',
        source: SOURCE_ID,
        paint: {
            'circle-radius': ['get', 'gr'],
            'circle-color': '#eeeeff',
            'circle-opacity': ['get', 'go'],
            'circle-blur': 0.85,
        },
    });

    map.addLayer({
        id: LAYER_CORE,
        type: 'circle',
        source: SOURCE_ID,
        paint: {
            'circle-radius': ['get', 'cr'],
            'circle-color': '#ffffff',
            'circle-opacity': ['get', 'co'],
        },
    });

    setLayerOrder();
}

function getStrikeVisuals(ageMs) {
    if (ageMs >= STRIKE_LIFETIME_MS) {
        return { co: 0, go: 0, cr: 0, gr: 0 };
    }

    var intensity;

    if (ageMs < 120) {
        intensity = 1.0;
    } else if (ageMs < 400) {
        var t = (ageMs - 120) / 280;
        intensity = 0.35 + 0.65 * (0.5 + 0.5 * Math.cos(t * Math.PI * 2.5));
    } else {
        var fadeProgress = (ageMs - 400) / (STRIKE_LIFETIME_MS - 400);
        intensity = Math.max(0, 1 - fadeProgress);
        intensity = intensity * intensity;
    }

    return {
        co: Math.min(1, intensity * 0.95),
        go: Math.min(0.55, intensity * 0.45),
        cr: 2 + intensity * 1.5,
        gr: 5 + intensity * 9,
    };
}

function updateAnimation() {
    var now = Date.now();

    strikes = strikes.filter(function(s) {
        return (now - s.t) < STRIKE_LIFETIME_MS;
    });

    var features = [];
    for (var i = 0; i < strikes.length; i++) {
        var s = strikes[i];
        var age = now - s.t;
        var v = getStrikeVisuals(age);
        if (v.co <= 0 && v.go <= 0) continue;
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [s.ln, s.lt] },
            properties: v,
        });
    }

    var source = map.getSource(SOURCE_ID);
    if (source) {
        source.setData({ type: 'FeatureCollection', features: features });
    }
}

function connectWebSocket() {
    if (ws) {
        try { ws.close(); } catch (e) { /* ignore */ }
        ws = null;
    }

    var url = WS_URLS[wsUrlIndex % WS_URLS.length];
    wsUrlIndex++;

    try {
        ws = new WebSocket(url);
    } catch (e) {
        console.warn('[lightning] WebSocket creation failed:', e);
        scheduleReconnect();
        return;
    }

    ws.onopen = function() {
        console.log('[lightning] connected to', url);
        ws.send(JSON.stringify({ a: 418 }));
    };

    ws.onmessage = function(event) {
        try {
            var data = JSON.parse(event.data);
            if (typeof data.lat === 'number' && typeof data.lon === 'number') {
                strikes.push({ lt: data.lat, ln: data.lon, t: Date.now() });
            }
        } catch (e) { /* ignore malformed messages */ }
    };

    ws.onerror = function() {
        console.warn('[lightning] WebSocket error');
    };

    ws.onclose = function() {
        ws = null;
        if (active) scheduleReconnect();
    };
}

function scheduleReconnect() {
    if (!active) return;
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(function() {
        reconnectTimeout = null;
        if (active) connectWebSocket();
    }, WS_RECONNECT_DELAY_MS);
}

function startAnimationLoop() {
    if (animationTimer) return;
    animationTimer = setInterval(updateAnimation, ANIMATION_INTERVAL_MS);
}

function stopAnimationLoop() {
    if (animationTimer) {
        clearInterval(animationTimer);
        animationTimer = null;
    }
}

function start() {
    if (active) return;
    active = true;

    if (!map.getSource(SOURCE_ID)) {
        createLayers();
    } else {
        for (var i = 0; i < LAYERS.length; i++) {
            if (map.getLayer(LAYERS[i])) {
                map.setLayoutProperty(LAYERS[i], 'visibility', 'visible');
            }
        }
    }

    connectWebSocket();
    startAnimationLoop();
}

function stop() {
    active = false;
    stopAnimationLoop();

    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    if (ws) {
        try { ws.close(); } catch (e) { /* ignore */ }
        ws = null;
    }

    strikes = [];

    var source = map.getSource(SOURCE_ID);
    if (source) {
        source.setData({ type: 'FeatureCollection', features: [] });
    }

    for (var i = 0; i < LAYERS.length; i++) {
        if (map.getLayer(LAYERS[i])) {
            map.setLayoutProperty(LAYERS[i], 'visibility', 'none');
        }
    }
}

module.exports = { start: start, stop: stop, LAYERS: LAYERS };
