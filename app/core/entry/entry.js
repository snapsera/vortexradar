/*
* This file is the entry point for the project - everything starts here.
*/

function load() {
    window.stormTrackData = {};
    window.stormTrackData.map_type = 'dark';

    require('../../weather_station/menu_item');
    require('../../radio/menu_item');

    require('../../alerts/menu_item');
    require('../../alerts/alerts_panel').init();
    require('../../alerts/focus_new_alerts').init();
    require('../../alerts/alerts_display_popup').init();
    require('../../alerts/fetch_data')._fetch_data();
    require('../../alerts/warning_counter').init();

    require('../../metars/entry');
    require('../menu/stormTrackProMenu');
    require('../menu/productSelectionMenu');
    require('../menu/settings');
    require('../../radar/inspector/entry');
    require('../../radar/station_markers/station_marker_menu');
    require('../../radar/radar_message/radar_message');
    require('../../surface_fronts/menu_item');
    require('../../hurricanes/menu_item');
    require('../../spc/menu_item');
    require('../../timezones/menu_item');
    require('../about/about_screen');
    require('../../devtools/test_alerts');
    require('../../devtools/dev_console').init();
    require('../../screenshot/menu_item');
    require('../../draw/menu_item');
    require('../attribution/attribution');
    require('../../radar/colormaps/menu');
    require('../../radar/updater/radar_loop_ui').init();
    require('../notifications/notification_bubble').init();
    require('../header_clock').init();
    require('../cursor_coords');
    require('../../ui/alertTicker').init();
    require('../../ui/alert_voice').init();
    require('../../ui/audible_alerts').init();
    require('../../ui/fullscreen_toggle').init();
    require('../../forecast/forecast_modal').init();
    require('../../lightning/menu_item');

    window.dispatchEvent(new CustomEvent('stormTrackModulesLoaded'));
}

function _load_map() {
    const map = require('../map/map');
    function _on_map_loaded() {
        window.dispatchEvent(new CustomEvent('stormTrackMapLoaded'));
        load();
    }
    if (map.loaded()) {
        _on_map_loaded();
    } else {
        map.on('load', function() {
            _on_map_loaded();
        });
    }
}

if (document.readyState == 'complete' || document.readyState == 'interactive') {
    _load_map();
} else if (document.readyState == 'loading') {
    window.onload = function () {
        _load_map();
    }
}