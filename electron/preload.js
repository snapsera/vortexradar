const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopUpdater', {
    onStatus: function(callback) {
        if (typeof callback !== 'function') return function() {};
        const listener = function(_event, payload) {
            callback(payload || {});
        };
        ipcRenderer.on('desktop-updater-status', listener);
        return function() {
            ipcRenderer.removeListener('desktop-updater-status', listener);
        };
    },
});
