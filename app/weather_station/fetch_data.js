const plotData = require('./plot_data');
const ut = require('../core/utils');

function fetchData() {
    $.getJSON('https://attic-server.herokuapp.com/weather-station/index.php', function(data) {
        ut.loadingSpinner(false);
        plotData(data, data.observations);
    })
}

module.exports = fetchData;
