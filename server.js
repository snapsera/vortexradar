const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.post('/api/save-defaults', (req, res) => {
    const defaults = req.body;
    if (!defaults || typeof defaults !== 'object') {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    const filePath = path.join(__dirname, 'site_defaults.json');
    fs.writeFile(filePath, JSON.stringify(defaults, null, 2), 'utf8', (err) => {
        if (err) {
            console.error('Failed to write site_defaults.json:', err);
            return res.status(500).json({ error: 'Write failed' });
        }
        console.log('Site defaults saved to site_defaults.json');
        res.json({ ok: true });
    });
});

app.get('/api/metar', async (req, res) => {
    const ids = req.query.ids || '';
    if (!ids) return res.status(400).json({ error: 'Missing ids parameter' });
    try {
        const url = 'https://aviationweather.gov/api/data/metar?ids=' + encodeURIComponent(ids) + '&format=json';
        const resp = await fetch(url);
        if (!resp.ok) return res.status(resp.status).json({ error: 'Upstream error' });
        const data = await resp.json();
        res.json(data);
    } catch (e) {
        console.error('[METAR proxy]', e.message);
        res.status(502).json({ error: 'Fetch failed' });
    }
});

app.get('/api/earthquakes', async (req, res) => {
    try {
        const url = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson';
        const resp = await fetch(url);
        if (!resp.ok) return res.status(resp.status).json({ error: 'Upstream error' });
        const data = await resp.json();
        res.json(data);
    } catch (e) {
        console.error('[Earthquake proxy]', e.message);
        res.status(502).json({ error: 'Fetch failed' });
    }
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

app.listen(PORT, '0.0.0.0', () => {
    console.log('Vortex Radar running on port ' + PORT);
}).on('error', (err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
