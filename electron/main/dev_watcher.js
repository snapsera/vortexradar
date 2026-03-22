const fs = require('fs');
const path = require('path');

function createDevWatcher(options) {
    const rootDir = options.rootDir;
    const onReload = options.onReload;
    const onRestart = options.onRestart;
    const getMode = options.getMode;

    let watchers = [];
    let timer = null;
    const debounceMs = 350;

    const watchTargets = [
        'app',
        'dist',
        'index.html',
        'index.css',
        'main.js'
    ];

    function schedule() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            const mode = getMode();
            if (mode === 'off') return;
            if (mode === 'restartApp') onRestart();
            else onReload();
        }, debounceMs);
    }

    function start() {
        for (const relTarget of watchTargets) {
            const absTarget = path.join(rootDir, relTarget);
            if (!fs.existsSync(absTarget)) continue;

            try {
                const watcher = fs.watch(absTarget, { recursive: true }, (_eventType, fileName) => {
                    if (!fileName) return;
                    if (String(fileName).includes('node_modules')) return;
                    schedule();
                });
                watchers.push(watcher);
            } catch (_) {
                // Ignore unsupported watch roots on this platform/path.
            }
        }
    }

    function stop() {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        for (const watcher of watchers) {
            try {
                watcher.close();
            } catch (_) {}
        }
        watchers = [];
    }

    return {
        start,
        stop
    };
}

module.exports = {
    createDevWatcher
};
