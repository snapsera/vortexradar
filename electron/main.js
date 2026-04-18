const path = require('path');
const net = require('net');
const { app, BrowserWindow, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const { startServer } = require('../server');

const HOST = '127.0.0.1';
const SERVER_READY_TIMEOUT_MS = 15000;
const SERVER_RETRY_DELAY_MS = 250;
const UPDATE_CHECK_DELAY_MS = 10000;
const iconPath = path.join(__dirname, '..', 'images', 'vortexicon.ico');

let serverInstance = null;
let serverPort = null;
let mainWindow = null;
let isQuitting = false;

function setupAutoUpdates() {
    if (!app.isPackaged) {
        console.log('[Updater] Skipping update checks in development.');
        return;
    }

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
        console.log('[Updater] Checking for updates...');
    });

    autoUpdater.on('update-available', (info) => {
        console.log(`[Updater] Update available: ${info?.version || 'unknown version'}`);
    });

    autoUpdater.on('update-not-available', () => {
        console.log('[Updater] No updates available.');
    });

    autoUpdater.on('download-progress', (progress) => {
        if (!progress?.percent) {
            return;
        }
        console.log(`[Updater] Download progress: ${Math.round(progress.percent)}%`);
    });

    autoUpdater.on('update-downloaded', async (info) => {
        console.log(`[Updater] Update downloaded: ${info?.version || 'unknown version'}`);

        const response = await dialog.showMessageBox({
            type: 'info',
            buttons: ['Install and Restart', 'Later'],
            defaultId: 0,
            cancelId: 1,
            title: 'Update Ready',
            message: 'A Vortex Radar update has been downloaded.',
            detail: 'Restart now to install the update, or choose Later to install on next app quit.',
        });

        if (response.response === 0) {
            autoUpdater.quitAndInstall();
        }
    });

    autoUpdater.on('error', (error) => {
        console.error('[Updater] Failed to check/apply updates:', error);
    });

    setTimeout(() => {
        autoUpdater.checkForUpdates();
    }, UPDATE_CHECK_DELAY_MS);
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const candidate = net.createServer();
        candidate.unref();
        candidate.on('error', reject);
        candidate.listen(0, HOST, () => {
            const address = candidate.address();
            candidate.close((closeErr) => {
                if (closeErr) {
                    reject(closeErr);
                    return;
                }
                if (!address || typeof address === 'string') {
                    reject(new Error('Failed to determine a free port.'));
                    return;
                }
                resolve(address.port);
            });
        });
    });
}

async function waitForServerReady(url) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < SERVER_READY_TIMEOUT_MS) {
        try {
            const response = await fetch(`${url}/api/live-mode/viewers`);
            if (response.ok) {
                return;
            }
        } catch (_) {
            // Retry until timeout.
        }
        await new Promise((resolve) => {
            setTimeout(resolve, SERVER_RETRY_DELAY_MS);
        });
    }
    throw new Error('Embedded web server did not become ready in time.');
}

async function startEmbeddedServer() {
    if (serverInstance) {
        return;
    }

    const defaultsPath = path.join(app.getPath('userData'), 'site_defaults.json');
    serverPort = await getFreePort();
    process.env.PORT = String(serverPort);
    process.env.SITE_DEFAULTS_PATH = defaultsPath;

    serverInstance = startServer({ port: serverPort, host: '127.0.0.1' });
    const serverUrl = `http://${HOST}:${serverPort}`;
    await waitForServerReady(serverUrl);
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1366,
        height: 900,
        minWidth: 1120,
        minHeight: 700,
        show: false,
        icon: iconPath,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    const serverUrl = `http://${HOST}:${serverPort}`;
    mainWindow.loadURL(serverUrl);
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function stopEmbeddedServer() {
    return new Promise((resolve) => {
        if (!serverInstance) {
            resolve();
            return;
        }
        serverInstance.close(() => {
            serverInstance = null;
            resolve();
        });
    });
}

app.setAppUserModelId('com.vortexradar.desktop');

app.on('window-all-closed', async () => {
    if (process.platform !== 'darwin') {
        await stopEmbeddedServer();
        app.quit();
    }
});

app.on('before-quit', async (event) => {
    if (isQuitting) {
        return;
    }
    event.preventDefault();
    isQuitting = true;
    await stopEmbeddedServer();
    app.quit();
});

app.whenReady().then(async () => {
    try {
        await startEmbeddedServer();
        createMainWindow();
        setupAutoUpdates();
    } catch (error) {
        console.error('[Electron] Failed to initialize desktop app:', error);
        await stopEmbeddedServer();
        app.exit(1);
    }
});
