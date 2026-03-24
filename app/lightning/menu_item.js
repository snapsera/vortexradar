const lightning = require('./lightning');
const armFunctions = require('../core/menu/vortexRadarMenu');
const settings_store = require('../core/menu/settings_store');

armFunctions.toggleswitchFunctions($('#armrLightningBtnSwitchElem'), function() {
    lightning.start();
}, function() {
    lightning.stop();
}, settings_store.saveFromDom);

var _saved = settings_store.load();
if (_saved.lightning) {
    $('#armrLightningBtnSwitchElem').prop('checked', true);
    lightning.start();
}
