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

app.use(express.static(path.join(__dirname), {
    extensions: ['html'],
    setHeaders(res, filePath) {
        if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.set('Cache-Control', 'no-cache');
        } else {
            res.set('Cache-Control', 'public, max-age=3600');
        }
    }
}));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('StormTrack Pro running on port ' + PORT);
}).on('error', (err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
