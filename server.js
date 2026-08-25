const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');

const app = express();
const DEFAULT_PORT = Number(process.env.PORT) || 9191;
const BUNDLED_SITE_DEFAULTS_FILE = path.join(__dirname, 'site_defaults.json');
const liveModeViewerStreams = new Map();
let liveModeViewerSeq = 0;
const apiCache = new Map();
const EARTHQUAKE_TTL_MS = 60 * 1000;
const METAR_TTL_MS = 30 * 1000;
const LOCATION_TTL_MS = 24 * 60 * 60 * 1000;

function getLocalLaunchTimestamp() {
    const now = new Date();
    const datePart = now.toLocaleDateString('en-US');
    const timePart = now.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    }).replace(' ', '');
    return `${datePart} @ ${timePart} Local`;
}

app.use(express.json());
app.use(compression());

function getSiteDefaultsFile() {
    return process.env.SITE_DEFAULTS_PATH || BUNDLED_SITE_DEFAULTS_FILE;
}

function _cache_get(key) {
    const entry = apiCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        apiCache.delete(key);
        return null;
    }
    return entry.value;
}

function _cache_set(key, value, ttlMs) {
    apiCache.set(key, {
        value,
        expiresAt: Date.now() + ttlMs
    });
}

app.post('/api/save-defaults', (req, res) => {
    const defaults = req.body;
    if (!defaults || typeof defaults !== 'object') {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    const siteDefaultsFile = getSiteDefaultsFile();
    fs.mkdir(path.dirname(siteDefaultsFile), { recursive: true }, (mkdirErr) => {
        if (mkdirErr) {
            console.error('Failed to prepare defaults directory:', mkdirErr);
            return res.status(500).json({ error: 'Directory prep failed' });
        }
        fs.writeFile(siteDefaultsFile, JSON.stringify(defaults, null, 2), 'utf8', (err) => {
            if (err) {
                console.error('Failed to write site defaults:', err);
                return res.status(500).json({ error: 'Write failed' });
            }
            console.log(`Site defaults saved to ${siteDefaultsFile}`);
            res.json({ ok: true });
        });
    });
});

app.get('/site_defaults.json', (req, res) => {
    const sendDefaultsFromPath = (targetPath) => {
        fs.readFile(targetPath, 'utf8', (readErr, content) => {
            if (readErr) {
                if (targetPath !== BUNDLED_SITE_DEFAULTS_FILE) {
                    return sendDefaultsFromPath(BUNDLED_SITE_DEFAULTS_FILE);
                }
                return res.status(404).json({ error: 'site_defaults.json not found' });
            }
            res.type('application/json').send(content);
        });
    };
    sendDefaultsFromPath(getSiteDefaultsFile());
});

app.get('/api/metar', async (req, res) => {
    const ids = req.query.ids || '';
    if (!ids) return res.status(400).json({ error: 'Missing ids parameter' });
    const cacheKey = `metar:${ids}`;
    const cached = _cache_get(cacheKey);
    if (cached) {
        res.set('Cache-Control', 'public, max-age=15');
        return res.json(cached);
    }
    try {
        const url = 'https://aviationweather.gov/api/data/metar?ids=' + encodeURIComponent(ids) + '&format=json';
        const resp = await fetch(url);
        if (!resp.ok) return res.status(resp.status).json({ error: 'Upstream error' });
        const data = await resp.json();
        _cache_set(cacheKey, data, METAR_TTL_MS);
        res.set('Cache-Control', 'public, max-age=15');
        res.json(data);
    } catch (e) {
        console.error('[METAR proxy]', e.message);
        res.status(502).json({ error: 'Fetch failed' });
    }
});

app.get('/api/earthquakes', async (req, res) => {
    const cached = _cache_get('earthquakes');
    if (cached) {
        res.set('Cache-Control', 'public, max-age=30');
        return res.json(cached);
    }
    try {
        const url = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson';
        const resp = await fetch(url);
        if (!resp.ok) return res.status(resp.status).json({ error: 'Upstream error' });
        const data = await resp.json();
        _cache_set('earthquakes', data, EARTHQUAKE_TTL_MS);
        res.set('Cache-Control', 'public, max-age=30');
        res.json(data);
    } catch (e) {
        console.error('[Earthquake proxy]', e.message);
        res.status(502).json({ error: 'Fetch failed' });
    }
});

app.get('/api/location', async (req, res) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        return res.status(400).json({ error: 'Invalid coordinates' });
    }

    const roundedLat = lat.toFixed(4);
    const roundedLon = lon.toFixed(4);
    const cacheKey = `location:${roundedLat},${roundedLon}`;
    const cached = _cache_get(cacheKey);
    if (cached) return res.json(cached);

    try {
        const url = `https://api.weather.gov/points/${roundedLat},${roundedLon}`;
        const upstream = await fetch(url, {
            headers: {
                Accept: 'application/geo+json',
                'User-Agent': 'Vortex Radar (https://vortexradar.snapsera.com)'
            }
        });
        if (!upstream.ok) return res.status(upstream.status).json({ error: 'Location lookup failed' });

        const data = await upstream.json();
        const relativeLocation = data?.properties?.relativeLocation;
        const properties = relativeLocation?.properties || {};
        const coordinates = relativeLocation?.geometry?.coordinates;
        if (!properties.city) return res.status(404).json({ error: 'No nearby city found' });

        const result = {
            name: properties.city,
            state: properties.state || '',
            lat: Array.isArray(coordinates) && Number.isFinite(Number(coordinates[1])) ? Number(coordinates[1]) : lat,
            lng: Array.isArray(coordinates) && Number.isFinite(Number(coordinates[0])) ? Number(coordinates[0]) : lon
        };
        _cache_set(cacheKey, result, LOCATION_TTL_MS);
        res.set('Cache-Control', 'public, max-age=3600');
        res.json(result);
    } catch (error) {
        console.error('[Location proxy]', error.message);
        res.status(502).json({ error: 'Location lookup unavailable' });
    }
});

app.get('/download/desktop-app', async (req, res) => {
    const releaseUrl = 'https://github.com/snapsera/vortexradar/releases/latest/download/Vortex%20Radar%20Setup.exe';
    try {
        const upstream = await fetch(releaseUrl, { redirect: 'follow' });
        if (!upstream.ok || !upstream.body) {
            return res.status(502).send('Failed to fetch installer.');
        }

        const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
        const contentLength = upstream.headers.get('content-length');
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', 'attachment; filename="Vortex Radar Setup.exe"');
        if (contentLength) res.setHeader('Content-Length', contentLength);
        res.setHeader('Cache-Control', 'no-store');

        const installerStream = Readable.fromWeb(upstream.body);
        installerStream.on('error', () => {
            if (!res.headersSent) {
                res.status(502).send('Installer stream failed.');
            } else {
                res.end();
            }
        });
        installerStream.pipe(res);
    } catch (error) {
        console.error('[Desktop Download Proxy]', error.message);
        res.status(502).send('Unable to download installer right now.');
    }
});

function getLiveModeViewerCount() {
    return liveModeViewerStreams.size;
}

function sendLiveModeViewerEvent(res, count) {
    res.write('event: viewers\n');
    res.write('data: ' + JSON.stringify({ count }) + '\n\n');
}

function broadcastLiveModeViewerCount() {
    const count = getLiveModeViewerCount();
    for (const stream of liveModeViewerStreams.values()) {
        sendLiveModeViewerEvent(stream.res, count);
    }
}

app.get('/api/live-mode/viewers', (req, res) => {
    res.json({ count: getLiveModeViewerCount() });
});

app.get('/api/live-mode/viewers/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const clientId = String(++liveModeViewerSeq);
    const keepAliveTimer = setInterval(() => {
        res.write(': keepalive\n\n');
    }, 25000);

    liveModeViewerStreams.set(clientId, { res, keepAliveTimer });
    sendLiveModeViewerEvent(res, getLiveModeViewerCount());
    broadcastLiveModeViewerCount();

    req.on('close', () => {
        const stream = liveModeViewerStreams.get(clientId);
        if (stream) {
            clearInterval(stream.keepAliveTimer);
            liveModeViewerStreams.delete(clientId);
        }
        broadcastLiveModeViewerCount();
    });
});

app.use(express.static(path.join(__dirname), {
    extensions: ['html'],
    etag: false,
    lastModified: false,
    setHeaders(res) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        res.set('Surrogate-Control', 'no-store');
    }
}));

app.get(['/spc', '/spc/'], (req, res) => {
    const params = new URLSearchParams(req.query || {});
    params.set('spc', '1');
    res.redirect(302, '/?' + params.toString());
});

app.get('*', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'index.html'));
});

function startServer({ port = DEFAULT_PORT, host = '0.0.0.0' } = {}) {
    const server = app.listen(port, host, () => {
        const address = server.address();
        const resolvedPort = typeof address === 'object' && address ? address.port : port;
        console.log(String.raw`
 /$$    /$$                      /$$                         /$$$$$$$                  /$$
| $$   | $$                     | $$                        | $$__  $$                | $$
| $$   | $$ /$$$$$$   /$$$$$$  /$$$$$$    /$$$$$$  /$$   /$$| $$  \ $$  /$$$$$$   /$$$$$$$  /$$$$$$   /$$$$$$
|  $$ / $$//$$__  $$ /$$__  $$|_  $$_/   /$$__  $$|  $$ /$$/| $$$$$$$/ |____  $$ /$$__  $$ |____  $$ /$$__  $$
 \  $$ $$/| $$  \ $$| $$  \__/  | $$    | $$$$$$$$ \  $$$$/ | $$__  $$  /$$$$$$$| $$  | $$  /$$$$$$$| $$  \__/
  \  $$$/ | $$  | $$| $$        | $$ /$$| $$_____/  >$$  $$ | $$  \ $$ /$$__  $$| $$  | $$ /$$__  $$| $$
   \  $/  |  $$$$$$/| $$        |  $$$$/|  $$$$$$$ /$$/\  $$| $$  | $$|  $$$$$$$|  $$$$$$$|  $$$$$$$| $$
    \_/    \______/ |__/         \___/   \_______/|__/  \__/|__/  |__/ \_______/ \_______/ \_______/|__/
`);
        console.log(`Running on port ${resolvedPort} -- ${getLocalLaunchTimestamp()}`);
    });

    server.on('error', (err) => {
        console.error('Failed to start server:', err);
        process.exitCode = 1;
    });

    return server;
}

if (require.main === module) {
    startServer();
}

module.exports = {
    app,
    startServer,
};
