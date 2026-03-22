const fetchData = require('./fetch_data');
const ut = require('../core/utils');
const armFunctions = require('../core/menu/stormTrackProMenu');

$('#armrWeatherStationBtn').click(function() {
    ut.loadingSpinner(true);
    fetchData();
    armFunctions.hideARMwindow();
})