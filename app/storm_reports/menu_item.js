const storm_reports = require('./storm_reports');
const armFunctions = require('../core/menu/vortexRadarMenu');
const settings_store = require('../core/menu/settings_store');

armFunctions.toggleswitchFunctions($('#armrStormReportsBtnSwitchElem'), function() {
    storm_reports.start();
}, function() {
    storm_reports.stop();
}, settings_store.saveFromDom);

var _saved = settings_store.load();
if (_saved.stormReports) {
    $('#armrStormReportsBtnSwitchElem').prop('checked', true);
    storm_reports.start();
}
