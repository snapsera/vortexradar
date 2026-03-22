const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stormTrackProDesktop', {
    onServerLifecycleStatus(callback) {
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on('server:lifecycle-status', handler);
        return () => ipcRenderer.removeListener('server:lifecycle-status', handler);
    },
    requestGracefulQuit() {
        return ipcRenderer.invoke('app:request-graceful-quit');
    },
    setDevAutoUpdateMode(mode) {
        return ipcRenderer.invoke('dev:set-auto-update-mode', mode);
    },
    getDevAutoUpdateMode() {
        return ipcRenderer.invoke('dev:get-auto-update-mode');
    },
    openExternalUrl(url) {
        return ipcRenderer.invoke('shell:open-external', url);
    },
    openAlertEditor() {
        return ipcRenderer.invoke('dev:open-alert-editor');
    }
});
