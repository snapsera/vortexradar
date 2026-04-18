const path = require('path');
const net = require('net');
const { app, BrowserWindow, dialog, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const { startServer } = require('../server');

const HOST = '127.0.0.1';
const DESKTOP_PREFERRED_PORT = 45721;
const SERVER_READY_TIMEOUT_MS = 15000;
const SERVER_RETRY_DELAY_MS = 250;
const UPDATE_CHECK_DELAY_MS = 10000;
const INSTALL_PREP_MAX_PERCENT = 95;
const INSTALL_PREP_STEP_PERCENT = 5;
const INSTALL_PREP_STEP_MS = 220;
const iconPath = path.join(__dirname, '..', 'images', 'vortexicon.ico');
const windowTitleBase = 'Vortex Radar | Advanced Weather';

let serverInstance = null;
let serverPort = null;
let mainWindow = null;
let isQuitting = false;
let installPrepInProgress = false;

function _send_update_status(payload) {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }
    mainWindow.webContents.send('desktop-updater-status', payload || {});
}

function _start_install_handoff_progress() {
    if (installPrepInProgress) return;
    installPrepInProgress = true;
    let percent = 0;
    _send_update_status({ state: 'installing', percent });

    const timer = setInterval(() => {
        percent = Math.min(INSTALL_PREP_MAX_PERCENT, percent + INSTALL_PREP_STEP_PERCENT);
        _send_update_status({ state: 'installing', percent });
        if (percent >= INSTALL_PREP_MAX_PERCENT) {
            clearInterval(timer);
            _send_update_status({ state: 'installing-handoff', percent });
            // Silent in-place install so users do not see the NSIS wizard.
            // Force-run after install to reopen the updated app automatically.
            autoUpdater.quitAndInstall(true, true);
        }
    }, INSTALL_PREP_STEP_MS);
}

// Desktop app should allow weather alert/audio playback without requiring
// a prior click gesture like standard browsers do.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function setupAutoUpdates() {
    if (!app.isPackaged) {
        console.log('[Updater] Skipping update checks in development.');
        return;
    }

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
        console.log('[Updater] Checking for updates...');
        _send_update_status({ state: 'checking' });
    });

    autoUpdater.on('update-available', (info) => {
        console.log(`[Updater] Update available: ${info?.version || 'unknown version'}`);
        _send_update_status({ state: 'available', version: info?.version || '' });
    });

    autoUpdater.on('update-not-available', () => {
        console.log('[Updater] No updates available.');
        _send_update_status({ state: 'up-to-date' });
    });

    autoUpdater.on('download-progress', (progress) => {
        if (!progress?.percent) {
            return;
        }
        const percent = Math.round(progress.percent);
        console.log(`[Updater] Download progress: ${percent}%`);
        _send_update_status({ state: 'downloading', percent: percent });
    });

    autoUpdater.on('update-downloaded', async (info) => {
        console.log(`[Updater] Update downloaded: ${info?.version || 'unknown version'}`);
        _send_update_status({ state: 'downloaded', version: info?.version || '' });

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
            _start_install_handoff_progress();
        }
    });

    autoUpdater.on('error', (error) => {
        console.error('[Updater] Failed to check/apply updates:', error);
        _send_update_status({ state: 'error', message: error?.message || 'Update check failed.' });
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

function canUsePort(port) {
    return new Promise((resolve, reject) => {
        const candidate = net.createServer();
        candidate.unref();
        candidate.on('error', reject);
        candidate.listen(port, HOST, () => {
            candidate.close((closeErr) => {
                if (closeErr) {
                    reject(closeErr);
                    return;
                }
                resolve();
            });
        });
    });
}

async function resolveDesktopPort() {
    try {
        await canUsePort(DESKTOP_PREFERRED_PORT);
        return DESKTOP_PREFERRED_PORT;
    } catch (_) {
        return getFreePort();
    }
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
    serverPort = await resolveDesktopPort();
    process.env.PORT = String(serverPort);
    process.env.SITE_DEFAULTS_PATH = defaultsPath;

    serverInstance = startServer({ port: serverPort, host: '127.0.0.1' });
    const serverUrl = `http://${HOST}:${serverPort}`;
    await waitForServerReady(serverUrl);
}

function createMainWindow() {
    const appVersion = app.getVersion();

    mainWindow = new BrowserWindow({
        width: 1366,
        height: 900,
        minWidth: 1120,
        minHeight: 700,
        show: false,
        icon: iconPath,
        title: `${windowTitleBase} (v${appVersion})`,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            devTools: false,
        },
    });

    const serverUrl = new URL(`http://${HOST}:${serverPort}`);
    serverUrl.searchParams.set('desktopApp', '1');
    serverUrl.searchParams.set('desktopVersion', appVersion);
    mainWindow.loadURL(serverUrl.toString());
    mainWindow.setMenuBarVisibility(false);
    mainWindow.once('ready-to-show', () => {
        mainWindow.maximize();
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
        Menu.setApplicationMenu(null);
        await startEmbeddedServer();
        createMainWindow();
        setupAutoUpdates();
    } catch (error) {
        console.error('[Electron] Failed to initialize desktop app:', error);
        await stopEmbeddedServer();
        app.exit(1);
    }
});
