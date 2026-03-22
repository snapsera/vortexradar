const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const { createProcessManager } = require('./electron/main/process_manager');
const { createDevWatcher } = require('./electron/main/dev_watcher');

const APP_NAME = 'StormTrack Pro';
const SERVER_HOST = '127.0.0.1';
const SERVER_PORT = 3333;
const SERVER_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;
const APP_ICON_PATH = path.join(__dirname, 'images', 'STP_icon.ico');

app.setName(APP_NAME);

let mainWindow;
let hasInitiatedShutdown = false;
let devAutoUpdateMode = 'off';

const processManager = createProcessManager({
    host: SERVER_HOST,
    port: SERVER_PORT,
    rootDir: __dirname
});

const devWatcher = createDevWatcher({
    rootDir: __dirname,
    getMode: () => devAutoUpdateMode,
    onReload: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.reloadIgnoringCache();
    },
    onRestart: () => {
        if (hasInitiatedShutdown) return;
        app.relaunch();
        app.exit(0);
    }
});

function sendLifecycleStatus(status, details) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('server:lifecycle-status', {
        status,
        details: details || null
    });
}

async function stopServerWithStatus() {
    sendLifecycleStatus('stopping', 'Stopping local server...');
    try {
        await processManager.stopServer();
        sendLifecycleStatus('stopped', 'Local server stopped.');
        return true;
    } catch (err) {
        sendLifecycleStatus('error', `Failed to stop server: ${err.message}`);
        return false;
    }
}

async function shutdownAppGracefully() {
    if (hasInitiatedShutdown) return;
    hasInitiatedShutdown = true;

    const stopped = await stopServerWithStatus();
    if (!stopped) {
        hasInitiatedShutdown = false;
        return;
    }

    setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.destroy();
        }
        app.quit();
    }, 700);
}

function createWindow() {
    mainWindow = new BrowserWindow({
        show: false,
        title: APP_NAME,
        icon: fs.existsSync(APP_ICON_PATH) ? APP_ICON_PATH : undefined,
        webPreferences: {
            preload: path.join(__dirname, 'electron', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.maximize();
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        mainWindow.focus();
    });

    mainWindow.on('close', async (event) => {
        if (hasInitiatedShutdown) return;
        event.preventDefault();
        sendLifecycleStatus('stopping', 'Stopping local server before exit...');
        await shutdownAppGracefully();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    mainWindow.loadURL(SERVER_URL);
}

ipcMain.handle('app:request-graceful-quit', async () => {
    await shutdownAppGracefully();
    return { ok: true };
});

ipcMain.handle('dev:set-auto-update-mode', (_event, mode) => {
    if (mode === 'restartApp' || mode === 'reloadWindow' || mode === 'off') {
        devAutoUpdateMode = mode;
    }
    return { ok: true, mode: devAutoUpdateMode };
});

ipcMain.handle('dev:get-auto-update-mode', () => ({
    mode: devAutoUpdateMode
}));

ipcMain.handle('shell:open-external', (_event, url) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
        shell.openExternal(url);
    }
});

let alertEditorWindow = null;
ipcMain.handle('dev:open-alert-editor', () => {
    if (alertEditorWindow && !alertEditorWindow.isDestroyed()) {
        alertEditorWindow.focus();
        return { ok: true };
    }
    alertEditorWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: 'Alert Polygon Editor',
        icon: fs.existsSync(APP_ICON_PATH) ? APP_ICON_PATH : undefined,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    alertEditorWindow.loadURL(`${SERVER_URL}/devtools/alert_editor.html`);
    alertEditorWindow.on('closed', () => { alertEditorWindow = null; });
    return { ok: true };
});

app.whenReady().then(async () => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' }
            ]
        }
    ]));
    sendLifecycleStatus('starting', 'Starting local server...');
    try {
        await processManager.startServer();
    } catch (err) {
        dialog.showErrorBox(APP_NAME, `Failed to start local server on ${SERVER_URL}\n\n${err.message}`);
        app.quit();
        return;
    }

    createWindow();
    sendLifecycleStatus('running', `Server running at ${SERVER_URL}`);

    if (!app.isPackaged) {
        devWatcher.start();
    }
});

app.on('window-all-closed', async () => {
    if (process.platform !== 'darwin') {
        await processManager.stopServer();
        app.quit();
    }
});

app.on('before-quit', async (event) => {
    if (hasInitiatedShutdown) return;
    event.preventDefault();
    await shutdownAppGracefully();
});

app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        try {
            if (processManager.getState() !== 'running') {
                await processManager.startServer();
            }
            createWindow();
        } catch (err) {
            dialog.showErrorBox(APP_NAME, `Could not reactivate app: ${err.message}`);
        }
    }
});