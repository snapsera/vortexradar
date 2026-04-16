const bzip = require('seek-bzip');

module.exports = function (self) {
    self.addEventListener('message', function (ev) {
        try {
            var decompressed = bzip.decodeBlock(ev.data, 32);
            self.postMessage({ message: 'finish', data: decompressed });
        } catch (e) {
            self.postMessage({ message: 'error', error: e.message || String(e) });
        }
    });
};
