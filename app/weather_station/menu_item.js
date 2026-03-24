const fetchData = require('./fetch_data');
const ut = require('../core/utils');
const armFunctions = require('../core/menu/vortexRadarMenu');

$('#armrWeatherStationBtn').click(function() {
    ut.loadingSpinner(true);
    fetchData();
    armFunctions.hideARMwindow();
})