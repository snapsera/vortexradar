var map = require('../core/map/map');
var map_funcs = require('../core/map/mapFunctions');
var setLayerOrder = require('../core/map/setLayerOrder');
var ut = require('../core/utils');

var LAYER_GLOW = 'lightningGlow';
var LAYER_CORE = 'lightningCore';
var SOURCE_ID = 'lightningSource';
var LAYERS = [LAYER_GLOW, LAYER_CORE];

var STRIKE_LIFETIME_MS = 6000;
var ANIMATION_INTERVAL_MS = 75;
var POLL_INTERVAL_MS = 20000;

var WS_ATTEMPTS = [
    { url: 'wss://ws1.blitzortung.org:3000/', msg: '{"time":0}', decode: false },
    { url: 'wss://ws7.blitzortung.org:3000/', msg: '{"time":0}', decode: false },
    { url: 'wss://ws5.blitzortung.org:3000/', msg: '{"time":0}', decode: false },
    { url: 'wss://ws6.blitzortung.org:3000/', msg: '{"time":0}', decode: false },
];

var ARCHIVE_CONTAINERS = [3, 1, 5, 4, 2, 6];
var ARCHIVE_BASE = 'https://www.limaps.org/JSON/';

var strikes = [];
var seenKeys = {};
var ws = null;
var animationTimer = null;
var pollTimer = null;
var active = false;
var wsAttemptIndex = 0;
var wsGotData = false;
var wsConnectTimer = null;
var mode = 'none'; // 'ws', 'poll', 'none'
var lastPollTime = 0;

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

// ── Strike animation math ──

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

function addStrike(lat, lon, displayTime) {
    var key = lat.toFixed(3) + ',' + lon.toFixed(3) + ',' + Math.floor(displayTime / 2000);
    if (seenKeys[key]) return;
    seenKeys[key] = true;
    strikes.push({ lt: lat, ln: lon, t: displayTime });

    // Prune seenKeys periodically
    if (Object.keys(seenKeys).length > 5000) {
        seenKeys = {};
    }
}

// ── LZW decoder for obfuscated Blitzortung WebSocket data ──

function lzwDecode(str) {
    var data = str.split('');
    if (data.length === 0) return '';

    var dict = {};
    var c = data[0];
    var f = c;
    var result = [c];
    var nextCode = 256;

    for (var i = 1; i < data.length; i++) {
        var code = data[i].charCodeAt(0);
        var entry;
        if (code < 256) {
            entry = data[i];
        } else if (dict[code] !== undefined) {
            entry = dict[code];
        } else {
            entry = f + c;
        }
        result.push(entry);
        c = entry.charAt(0);
        dict[nextCode] = f + c;
        nextCode++;
        f = entry;
    }
    return result.join('');
}

// ── WebSocket data source ──

function tryNextWebSocket() {
    if (!active) return;
    if (wsAttemptIndex >= WS_ATTEMPTS.length) {
        console.log('[lightning] all WebSocket endpoints failed, falling back to HTTP polling');
        startPolling();
        return;
    }

    var attempt = WS_ATTEMPTS[wsAttemptIndex];
    wsAttemptIndex++;
    wsGotData = false;

    console.log('[lightning] trying WebSocket:', attempt.url);

    try {
        if (ws) { try { ws.close(); } catch (e) { /* */ } }
        ws = new WebSocket(attempt.url);
    } catch (e) {
        console.warn('[lightning] WebSocket creation failed:', e.message);
        tryNextWebSocket();
        return;
    }

    var thisWs = ws;

    wsConnectTimer = setTimeout(function() {
        if (!wsGotData && ws === thisWs) {
            console.log('[lightning] no data from', attempt.url, '- trying next');
            try { ws.close(); } catch (e) { /* */ }
            ws = null;
            tryNextWebSocket();
        }
    }, 6000);

    ws.onopen = function() {
        console.log('[lightning] WebSocket connected to', attempt.url);
        try { ws.send(attempt.msg); } catch (e) { /* */ }
    };

    ws.onmessage = function(event) {
        if (!active) return;

        var raw = event.data;
        var parsed;

        try {
            // Try direct JSON first
            parsed = JSON.parse(raw);
        } catch (e) {
            // Try LZW decode
            try {
                var decoded = lzwDecode(raw);
                parsed = JSON.parse(decoded);
            } catch (e2) {
                return;
            }
        }

        if (parsed && typeof parsed.lat === 'number' && typeof parsed.lon === 'number') {
            if (!wsGotData) {
                wsGotData = true;
                mode = 'ws';
                if (wsConnectTimer) { clearTimeout(wsConnectTimer); wsConnectTimer = null; }
                console.log('[lightning] receiving live data via WebSocket');
            }
            addStrike(parsed.lat, parsed.lon, Date.now());
        }
    };

    ws.onerror = function() {
        console.warn('[lightning] WebSocket error on', attempt.url);
    };

    ws.onclose = function() {
        if (ws === thisWs) ws = null;
        if (active && mode === 'ws') {
            console.log('[lightning] WebSocket closed, reconnecting...');
            wsAttemptIndex = 0;
            setTimeout(function() { if (active) tryNextWebSocket(); }, 3000);
        }
    };
}

// ── HTTP polling fallback (Blitzortung JSON archive via CORS proxy) ──

function get10MinBlock(d) {
    return Math.floor(d.getUTCMinutes() / 10) * 10;
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function buildArchiveUrl(container, d) {
    var tenMin = get10MinBlock(d);
    return ARCHIVE_BASE +
        'C' + container + '/' +
        d.getUTCFullYear() + '/' +
        pad2(d.getUTCMonth() + 1) + '/' +
        pad2(d.getUTCDate()) + '/' +
        pad2(d.getUTCHours()) + '/' +
        pad2(tenMin) + '.json';
}

function fetchArchiveBlock(container, dateObj, callback) {
    var url = buildArchiveUrl(container, dateObj);
    var proxyUrl = ut.phpProxy + encodeURIComponent(url);

    fetch(proxyUrl).then(function(resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.text();
    }).then(function(text) {
        var results = [];
        var lines = text.split('\n');
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            try {
                var obj = JSON.parse(line);
                if (typeof obj.lat === 'number' && typeof obj.lon === 'number' && obj.time) {
                    results.push(obj);
                }
            } catch (e) { /* skip malformed lines */ }
        }
        callback(results);
    }).catch(function(err) {
        callback([]);
    });
}

function pollOnce() {
    if (!active || mode !== 'poll') return;

    var now = new Date();
    var prev = new Date(now.getTime() - 10 * 60 * 1000);
    var fetched = 0;
    var totalContainers = ARCHIVE_CONTAINERS.length;
    var allResults = [];

    function onDone() {
        fetched++;
        if (fetched < totalContainers * 2) return;

        if (allResults.length > 0) {
            console.log('[lightning] polled', allResults.length, 'strikes from archive');
        }

        var displayNow = Date.now();
        var spreadMs = Math.min(POLL_INTERVAL_MS, 15000);

        for (var i = 0; i < allResults.length; i++) {
            var s = allResults[i];
            var strikeEpoch = Math.floor(s.time / 1e6);
            if (strikeEpoch <= lastPollTime) continue;
            var stagger = Math.random() * spreadMs;
            addStrike(s.lat, s.lon, displayNow + stagger);
        }

        lastPollTime = Date.now();
    }

    for (var c = 0; c < ARCHIVE_CONTAINERS.length; c++) {
        var container = ARCHIVE_CONTAINERS[c];
        fetchArchiveBlock(container, now, function(results) {
            allResults = allResults.concat(results);
            onDone();
        });
        fetchArchiveBlock(container, prev, function(results) {
            allResults = allResults.concat(results);
            onDone();
        });
    }
}

function startPolling() {
    if (mode === 'poll') return;
    mode = 'poll';
    lastPollTime = Date.now() - 5 * 60 * 1000;
    console.log('[lightning] starting HTTP poll mode');
    pollOnce();
    pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
}

function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
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
    mode = 'none';
    wsAttemptIndex = 0;
    wsGotData = false;

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
    tryNextWebSocket();
}

function stop() {
    active = false;
    mode = 'none';
    stopAnimationLoop();
    stopPolling();

    if (wsConnectTimer) { clearTimeout(wsConnectTimer); wsConnectTimer = null; }
    if (ws) { try { ws.close(); } catch (e) { /* */ } ws = null; }

    strikes = [];
    seenKeys = {};

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
