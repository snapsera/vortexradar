const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname), {
    extensions: ['html'],
    setHeaders(res) {
        res.set('Cache-Control', 'public, max-age=3600');
    }
}));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`StormTrack Pro running on port ${PORT}`);
});
