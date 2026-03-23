var map = require('../core/map/map');
var map_funcs = require('../core/map/mapFunctions');
var setLayerOrder = require('../core/map/setLayerOrder');

var LAYER_GLOW = 'lightningGlow';
var LAYER_CORE = 'lightningCore';
var SOURCE_ID = 'lightningSource';
var LAYERS = [LAYER_GLOW, LAYER_CORE];

var STRIKE_LIFETIME_MS = 6000;
var ANIMATION_INTERVAL_MS = 75;
var WS_RECONNECT_MS = 3000;
var WS_SERVERS = [
    'ws1.blitzortung.org',
    'ws2.blitzortung.org',
    'ws7.blitzortung.org',
    'ws8.blitzortung.org',
];

var strikes = [];
var ws = null;
var animationTimer = null;
var active = false;
var wsServerIndex = 0;
var reconnectTimer = null;

// ── LZW decoder (matches official Blitzortung map decode function) ──

function decode(input) {
    var dict = {};
    var chars = input.split('');
    var firstChar = chars[0];
    var prevEntry = firstChar;
    var result = [firstChar];
    var nextCode = 256;
    var o = nextCode;

    for (var i = 1; i < chars.length; i++) {
        var code = chars[i].charCodeAt(0);
        var entry;
        if (nextCode > code) {
            entry = chars[i];
        } else if (dict[code]) {
            entry = dict[code];
        } else {
            entry = prevEntry + firstChar;
        }
        result.push(entry);
        firstChar = entry.charAt(0);
        dict[o] = prevEntry + firstChar;
        o++;
        prevEntry = entry;
    }
    return result.join('');
}

// ── Mapbox layers ──

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

// ── Strike animation ──

function getStrikeVisuals(ageMs) {
    if (ageMs >= STRIKE_LIFETIME_MS) return { co: 0, go: 0, cr: 0, gr: 0 };

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
    strikes = strikes.filter(function(s) { return (now - s.t) < STRIKE_LIFETIME_MS; });

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

// ── WebSocket connection (protocol extracted from official map.blitzortung.org) ──

function connectWebSocket() {
    if (ws) {
        try { ws.close(); } catch (e) { /* */ }
        ws = null;
    }

    var server = WS_SERVERS[wsServerIndex % WS_SERVERS.length];
    wsServerIndex++;
    var url = 'wss://' + server;

    console.log('[lightning] connecting to', url);

    try {
        ws = new WebSocket(url);
    } catch (e) {
        console.warn('[lightning] WebSocket creation failed:', e.message);
        scheduleReconnect();
        return;
    }

    ws.onopen = function() {
        console.log('[lightning] connected to', server);
        try {
            ws.send('{"a":111}');
        } catch (e) { /* */ }
    };

    ws.onmessage = function(event) {
        if (!active) return;
        try {
            var decoded = decode(event.data);
            var data = JSON.parse(decoded);

            if (typeof data.lat === 'number' && typeof data.lon === 'number' && 'delay' in data) {
                var lat = data.lat;
                var lon = data.lon;
                if (typeof data.latc === 'number') lat += data.latc;
                if (typeof data.lonc === 'number') lon += data.lonc;
                strikes.push({ lt: lat, ln: lon, t: Date.now() });
            }
        } catch (e) { /* skip malformed messages */ }
    };

    ws.onerror = function() {
        console.warn('[lightning] WebSocket error on', server);
    };

    ws.onclose = function() {
        ws = null;
        if (active) scheduleReconnect();
    };
}

function scheduleReconnect() {
    if (!active) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(function() {
        reconnectTimer = null;
        if (active) connectWebSocket();
    }, WS_RECONNECT_MS);
}

// ── Animation loop ──

function startAnimationLoop() {
    if (animationTimer) return;
    animationTimer = setInterval(updateAnimation, ANIMATION_INTERVAL_MS);
}

function stopAnimationLoop() {
    if (animationTimer) { clearInterval(animationTimer); animationTimer = null; }
}

// ── Public API ──

function start() {
    if (active) return;
    active = true;
    wsServerIndex = 0;

    console.log('[lightning] starting lightning tracker');

    if (!map.getSource(SOURCE_ID)) {
        createLayers();
    } else {
        for (var i = 0; i < LAYERS.length; i++) {
            if (map.getLayer(LAYERS[i])) {
                map.setLayoutProperty(LAYERS[i], 'visibility', 'visible');
            }
        }
    }

    startAnimationLoop();
    connectWebSocket();
}

function stop() {
    active = false;
    stopAnimationLoop();

    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { try { ws.close(); } catch (e) { /* */ } ws = null; }

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

    console.log('[lightning] stopped');
}

module.exports = { start: start, stop: stop, LAYERS: LAYERS };
