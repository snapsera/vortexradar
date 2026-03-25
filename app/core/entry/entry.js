/*
* This file is the entry point for the project - everything starts here.
*/

function _setLocalStorageSnapshotValue(key, value) {
    if (!key || key.indexOf('vortexRadar_') !== 0) return;
    try {
        if (value === undefined || value === null) {
            localStorage.removeItem(key);
            return;
        }
        if (typeof value === 'string') {
            localStorage.setItem(key, value);
            return;
        }
        localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
}

function _is_local_dev_mode() {
    if (typeof window === 'undefined' || !window.location) return false;
    const host = window.location.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function _configure_console_logging() {
    if (_is_local_dev_mode()) return;
    if (typeof console === 'undefined') return;

    const noOp = function () {};
    const methodsToMute = [
        'log', 'info', 'debug', 'warn', 'error',
        'trace', 'table', 'group', 'groupCollapsed', 'groupEnd'
    ];
    methodsToMute.forEach((method) => {
        if (typeof console[method] === 'function') {
            console[method] = noOp;
        }
    });
}

function _seed_site_defaults_if_needed(done) {
    let hasSettings = false;
    try {
        hasSettings = localStorage.getItem('vortexRadar_settings') !== null;
    } catch (_) {}
    if (hasSettings) {
        done();
        return;
    }

    fetch('/site_defaults.json?_=' + Date.now(), { cache: 'no-store' })
        .then(function(res) {
            if (!res.ok) throw new Error('Failed to fetch site defaults');
            return res.json();
        })
        .then(function(payload) {
            const isWrappedPayload = payload && typeof payload === 'object' &&
                (payload.settings || payload.localStorage);
            const settingsPayload = isWrappedPayload ? payload.settings : payload;
            const localStoragePayload = isWrappedPayload ? payload.localStorage : null;

            if (localStoragePayload && typeof localStoragePayload === 'object') {
                for (const [key, value] of Object.entries(localStoragePayload)) {
                    _setLocalStorageSnapshotValue(key, value);
                }
            }

            if (settingsPayload && typeof settingsPayload === 'object') {
                try {
                    localStorage.setItem('vortexRadar_settings', JSON.stringify(settingsPayload));
                } catch (_) {}
            }
        })
        .catch(function() {})
        .finally(function() {
            done();
        });
}

function load() {
    window.stormTrackData = {};
    window.stormTrackData.map_type = 'dark';
    try {
        const params = new URLSearchParams(window.location.search);
        window.stormTrackData.radarPreviewMode = params.get('radarPreview') === '1';
    } catch (_) {
        window.stormTrackData.radarPreviewMode = false;
    }

    _seed_site_defaults_if_needed(function() {
        require('../../weather_station/menu_item');
        require('../../radio/menu_item');

        require('../../alerts/menu_item');
        require('../../alerts/alerts_panel').init();
        require('../../alerts/focus_new_alerts').init();
        require('../../alerts/alerts_display_popup').init();
        require('../../alerts/fetch_data')._fetch_data();
        require('../../alerts/warning_counter').init();

        require('../../metars/entry');
        require('../menu/vortexRadarMenu');
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
        require('../../devtools/accent_tester');
        require('../../devtools/dev_console').init();
        require('../../screenshot/menu_item');
        require('../../impact_timeline/menu_item');
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
        require('../../radar/preview_embed_mode').init();
        require('../../lightning/menu_item');

        window.dispatchEvent(new CustomEvent('stormTrackModulesLoaded'));
    });
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
    _configure_console_logging();
    _load_map();
} else if (document.readyState == 'loading') {
    window.onload = function () {
        _configure_console_logging();
        _load_map();
    }
}