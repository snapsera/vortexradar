const showStations = require('./station_markers');
const radar_scan_animation = require('./radar_scan_animation');
const map = require('../../core/map/map');
const settings_store = require('../../core/menu/settings_store');

const iconElem = '#stationMenuItemIcon';

$(iconElem).on('click', function() {
    if (window?.stormTrackData?.usRadarEnabled) {
        return;
    }

    if ($(iconElem).hasClass('menu_item_not_selected')) {
        $(iconElem).removeClass('menu_item_not_selected');
        $(iconElem).addClass('menu_item_selected');

        $('#dataDiv').data('stationMarkersVisible', true);
        if (map.getLayer('stationSymbolLayer')) {
            map.setLayoutProperty('stationSymbolLayer', 'visibility', 'visible');
        } else {
            showStations();
        }

        if (map.getLayer('station_range_layer')) {
            var radiusEnabled = $('#armrRadarRadiusBtnSwitchElem').is(':checked');
            map.setLayoutProperty('station_range_layer', 'visibility', radiusEnabled ? 'visible' : 'none');
        }

        var sweepEnabled = settings_store.load().radarSweep;
        if (sweepEnabled !== false && window.stormTrackData?.currentStation) {
            radar_scan_animation.update(window.stormTrackData.currentStation);
        }
    } else if ($(iconElem).hasClass('menu_item_selected')) {
        $(iconElem).removeClass('menu_item_selected');
        $(iconElem).addClass('menu_item_not_selected');

        $('#dataDiv').data('stationMarkersVisible', false);
        map.setLayoutProperty('stationSymbolLayer', 'visibility', 'none');

        if (map.getLayer('station_range_layer')) {
            map.setLayoutProperty('station_range_layer', 'visibility', 'none');
        }

        radar_scan_animation.remove();
    }
})

$('#stationMenuItemIcon').removeClass('menu_item_not_selected');
$('#stationMenuItemIcon').addClass('menu_item_selected');
showStations();