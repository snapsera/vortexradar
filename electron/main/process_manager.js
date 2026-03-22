const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = 3333;

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
    '.txt': 'text/plain; charset=utf-8',
    '.map': 'application/json; charset=utf-8'
};

function createProcessManager(options = {}) {
    const host = options.host || HOST;
    const port = options.port || PORT;
    const rootDir = options.rootDir || process.cwd();

    let server = null;
    let state = 'stopped';

    function getState() {
        return state;
    }

    function toSafePath(urlPath) {
        const decoded = decodeURIComponent((urlPath || '/').split('?')[0]);
        const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
        return normalized === path.sep ? '/index.html' : normalized;
    }

    function resolveFilePath(requestUrl) {
        const safePath = toSafePath(requestUrl);
        const candidate = path.resolve(rootDir, `.${safePath}`);
        if (!candidate.startsWith(path.resolve(rootDir))) {
            return path.resolve(rootDir, 'index.html');
        }
        return candidate;
    }

    function sendFile(res, filePath) {
        fs.stat(filePath, (statErr, stats) => {
            if (statErr || !stats.isFile()) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Not found');
                return;
            }

            const ext = path.extname(filePath).toLowerCase();
            const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';

            res.writeHead(200, {
                'Content-Type': contentType,
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                Pragma: 'no-cache',
                Expires: '0'
            });

            const stream = fs.createReadStream(filePath);
            stream.on('error', () => {
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                }
                res.end('Internal server error');
            });
            stream.pipe(res);
        });
    }

    async function startServer() {
        if (state === 'running') return { host, port };
        if (state === 'starting') {
            throw new Error('Server start already in progress');
        }

        state = 'starting';

        await new Promise((resolve, reject) => {
            const nextServer = http.createServer((req, res) => {
                const filePath = resolveFilePath(req.url);
                sendFile(res, filePath);
            });

            nextServer.on('error', (err) => {
                state = 'stopped';
                reject(err);
            });

            nextServer.listen(port, host, () => {
                server = nextServer;
                state = 'running';
                resolve();
            });
        });

        return { host, port };
    }

    async function stopServer() {
        if (state === 'stopped') return;
        if (state === 'stopping') return;
        if (!server) {
            state = 'stopped';
            return;
        }

        state = 'stopping';

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                state = 'running';
                reject(new Error('Timed out waiting for local server to stop'));
            }, 6000);

            server.close(() => {
                clearTimeout(timeout);
                state = 'stopped';
                server = null;
                resolve();
            });
        });
    }

    return {
        startServer,
        stopServer,
        getState,
        host,
        port
    };
}

module.exports = {
    createProcessManager
};
