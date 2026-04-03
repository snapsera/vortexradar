const turf = require('@turf/turf');
const ut = require('../../core/utils');
const map = require('../../core/map/map');
const get_station_status = require('./get_station_status');
const set_layer_order = require('../../core/map/setLayerOrder');
const icons = require('../../core/map/icons/icons');
const radar_scan_animation = require('./radar_scan_animation');

const NEXRADLevel2File = require('../libnexrad/level2/level2_parser');
const Level2Factory = require('../libnexrad/level2/level2_factory');

const NEXRADLevel3File = require('../libnexrad/level3/level3_parser');
const Level3Factory = require('../libnexrad/level3/level3_factory');

const loaders_nexrad = require('../libnexrad/loaders_nexrad');
const nexrad_locations = require('../libnexrad/nexrad_locations').NEXRAD_LOCATIONS;
const { get_station_state } = require('../libnexrad/nexrad_locations');
const settings_store = require('../../core/menu/settings_store');

function _copy(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function _is_legacy_marker_style_enabled() {
    const saved = settings_store.load();
    return !!saved.radarSiteLegacyStyle;
}

function _build_legacy_icon_expression() {
    return [
        'case',
        ['==', ['get', 'selected'], 'yes'],
        'blue_station',
        ['==', ['get', 'clicked'], 'yes'],
        'blue_station',
        ['==', ['get', 'status'], 'down'],
        'red_station',
        ['==', ['get', 'type'], 'TDWR'],
        'orange_station',
        'grey_station'
    ];
}

function _build_circle_icon_expression() {
    return [
        'case',
        ['==', ['get', 'selected'], 'yes'],
        'blue_station_circle',
        ['==', ['get', 'clicked'], 'yes'],
        'blue_station_circle',
        ['==', ['get', 'status'], 'down'],
        'red_station_circle',
        ['==', ['get', 'type'], 'TDWR'],
        'orange_station_circle',
        'grey_station_circle'
    ];
}

function do_when_map_load(func) {
    setTimeout(function() {
        if (map.loaded()) {
            func();
        } else {
            map.on('load', function() {
                func();
            })
        }
    }, 0)
}

/**
 * Helper function that generates a geojson object from a simple object with radar station data.
 * 
 * @param {Object} status_info OPTIONAL - An object containing the status of each radar station, from the "get_station_status" function.
 * @returns {Object} A geojson object containing the radar station data.
 */
function _generate_stations_geojson(status_info = null) {
    const saved = settings_store.load();
    const savedStation = saved.currentStation;
    var points = [];
    for (var station in nexrad_locations) {
        if (station != 'KLIX') {
            if (nexrad_locations[station].NONSTANDARD == undefined || nexrad_locations[station].NONSTANDARD == false) {
                if (nexrad_locations[station].type == 'WSR-88D' || nexrad_locations[station].type == 'TDWR') {
                    const lat = nexrad_locations[station].lat;
                    const lon = nexrad_locations[station].lon;

                    const station_properties = _copy(nexrad_locations[station]);
                    station_properties.station_id = station;
                    if (status_info != null) {
                        station_properties.status = status_info[station]?.status;
                    }
                    station_properties.useLegacyStyle = _is_legacy_marker_style_enabled();
                    station_properties.selected = (savedStation === station) ? 'yes' : 'no';
                    station_properties.clicked = 'no';

                    const point = turf.point([lon, lat], station_properties);
                    if (nexrad_locations[station].type == 'WSR-88D') {
                        point.properties.order = 1;
                    } else {
                        point.properties.order = 2;
                    }
                    points.push(point);
                }
            }
        }
    }
    const feature_collection = turf.featureCollection(points);
    return feature_collection;
}

/**
 * Helper function that adds the radar station layer to the map.
 * 
 * @param {Object} radar_stations_geojson A geojson object containing the radar station data. Comes from the "_generate_stations_geojson" function.
 * @param {Function} callback A callback function.
 */
function _add_stations_layer(radar_stations_geojson, callback) {
    icons.add_icon_svg([
        [icons.icons.grey_station_marker, 'grey_station'],
        [icons.icons.blue_station_marker, 'blue_station'],
        [icons.icons.green_station_marker, 'green_station'],
        [icons.icons.red_station_marker, 'red_station'],
        [icons.icons.orange_station_marker, 'orange_station'],
        [icons.icons.grey_station_circle, 'grey_station_circle'],
        [icons.icons.blue_station_circle, 'blue_station_circle'],
        [icons.icons.green_station_circle, 'green_station_circle'],
        [icons.icons.red_station_circle, 'red_station_circle'],
        [icons.icons.orange_station_circle, 'orange_station_circle'],
    ], () => {
        map.addSource('stationSymbolLayer', {
            'type': 'geojson',
            'generateId': true,
            'data': radar_stations_geojson
        });

        // Add a symbol layer
        map.addLayer({
            'id': 'stationSymbolLayer',
            'type': 'symbol',
            'source': 'stationSymbolLayer',
            'layout': {
                'symbol-sort-key': ['get', 'order'],
                'icon-image': [
                    'case',
                    ['get', 'useLegacyStyle'],
                    _build_legacy_icon_expression(),
                    _build_circle_icon_expression()
                ],
                'icon-size': [
                    'case',
                    ['get', 'useLegacyStyle'],
                    0.23,
                    0.18
                ],
                'text-field': [
                    'case',
                    ['get', 'useLegacyStyle'],
                    ['get', 'station_id'],
                    ''
                ],
                'text-size': 13,
                'text-font': [
                    'Arial Unicode MS Bold'
                ],
            },
            'paint': {
                'text-color': '#c8d0dc',
                'text-halo-color': 'rgba(0,0,0,0.7)',
                'text-halo-width': 1
            }
        });

        get_station_status((data) => {
            window.stormTrackData.radar_station_status = data;
            const statusified_geojson = _generate_stations_geojson(data);
            map.getSource('stationSymbolLayer').setData(statusified_geojson);

            var currentStation = window.stormTrackData?.currentStation;
            if (currentStation && data[currentStation]) {
                var statusEl = $('#radarStationStatus');
                statusEl.removeClass('radarStationStatus-up radarStationStatus-down radarStationStatus-unknown');
                statusEl.addClass(data[currentStation].status === 'up' ? 'radarStationStatus-up' : 'radarStationStatus-down');
            }
        });

        set_layer_order();

        callback();
    });
}

/**
 * Code that executes when the mouse enters a station's bubble
 */
function mouse_over() {
    map.getCanvas().style.cursor = 'pointer';
}
/**
 * Code that executes when the mouse leaves a station's bubble
 */
function mouse_out() {
    map.getCanvas().style.cursor = '';
}

function mouse_move(e) {
    const station = e.features[0].properties.station_id;
    const geojson = map.getSource('stationSymbolLayer')._data;
    for (var i in geojson.features) {
        if (geojson.features[i].properties.station_id == station) {
            geojson.features[i].properties.clicked = 'yes';
        } else {
            geojson.features[i].properties.clicked = 'no';
        }
    }
    map.getSource('stationSymbolLayer').setData(geojson);
}

function _set_selected_station(stationId) {
    if (!map.getSource('stationSymbolLayer')) return;
    const sourceData = map.getSource('stationSymbolLayer')._data;
    if (!sourceData || !sourceData.features) return;

    const updated = _copy(sourceData);
    for (let i = 0; i < updated.features.length; i++) {
        const isSelected = updated.features[i].properties.station_id === stationId;
        updated.features[i].properties.selected = isSelected ? 'yes' : 'no';
    }
    map.getSource('stationSymbolLayer').setData(updated);
}

/**
 * Function that enables all mouse-related event listeners for the radar station layer
 */
function _enable_mouse_listeners() {
    map.on('mouseover', 'stationSymbolLayer', mouse_over);
    map.on('mouseout', 'stationSymbolLayer', mouse_out);
}
/**
 * Function that disables all mouse-related event listeners for the radar station layer
 */
function _disable_mouse_listeners() {
    map.off('mouseover', 'stationSymbolLayer', mouse_over);
    map.off('mouseout', 'stationSymbolLayer', mouse_out);
}

/**
 * Initialize the mouse listeners for the first time.
 */
function _init_mouse_listeners() {
    _enable_mouse_listeners();
}

function _is_us_radar_enabled() {
    if (window?.stormTrackData?.usRadarEnabled) return true;
    const saved = settings_store.load();
    return !!saved.usRadar;
}
/**
 * Select a radar station by ID. Updates UI and loads radar data.
 * Used by both click handler and saved-station restore.
 */
function selectStation(stationId, stationType, options) {
    options = options || {};
    if (_is_us_radar_enabled()) return;
    if (!stationId || !nexrad_locations[stationId]) return;
    if (window.stormTrackData.currentStation === stationId) {
        _set_selected_station(stationId);
        return;
    }

    if (window?.stormTrackData?.current_RadarUpdater != undefined) {
        window.stormTrackData.current_RadarUpdater.disable();
    }

    _set_selected_station(stationId);
    window.stormTrackData.currentStation = stationId;
    $('#radarStation').html(stationId);
    var locName = nexrad_locations[stationId].name;
    var locState = get_station_state(stationId);
    $('#radarLocation').html(locState ? locName + ', ' + locState : locName);
    window.stormTrackData.L2_file_id = '';

    var sweepEnabled = settings_store.load().radarSweep;
    if (sweepEnabled !== false) {
        radar_scan_animation.update(stationId);
    }

    var productToLoad;
    var abbvProductToLoad;
    if (stationType == 'WSR-88D') {
        $('#wsr88d_psm').show();
        $('#tdwr_psm').hide();
        $('#level2_psm').hide();
        productToLoad = 'N0B';
        abbvProductToLoad = 'ref';
        $('#productsDropdownTriggerText').html(window.longProductNames[abbvProductToLoad]);
    } else if (stationType == 'TDWR') {
        $('#wsr88d_psm').hide();
        $('#tdwr_psm').show();
        $('#level2_psm').hide();
        productToLoad = 'TZ0';
        abbvProductToLoad = 'sr-ref';
        $('#productsDropdownTriggerText').html(window.longProductNames[abbvProductToLoad]);
    } else {
        return;
    }

    $('#radarInfoSpan').show();
    window.stormTrackData.from_file_upload = false;
    window.dispatchEvent(new CustomEvent('radarBaseSelectionRequested', {
        detail: {
            station: stationId,
            product: productToLoad
        }
    }));
    loaders_nexrad.quick_level_3_plot(stationId, productToLoad, (L3Factory) => {});

    if (options.persist !== false) {
        // Persist last used station
        const s = settings_store.load();
        s.currentStation = stationId;
        settings_store.save(s);
    }
}

/**
 * Initialize the click listener for the first time.
 */
function _init_click_listener() {
    map.on('click', 'stationSymbolLayer', (e) => {
        const base = e.features[0].properties;
        selectStation(base.station_id, base.type);
    });
}


/**
 * Main function.
 */
function showStations() {
    const radar_stations_geojson = _generate_stations_geojson();

    _add_stations_layer(radar_stations_geojson, () => {
        _init_mouse_listeners();
        _init_click_listener();

        // Restore last used radar site from saved settings
        const saved = settings_store.load();
        const savedStation = saved.currentStation;
        if (!saved.usRadar && savedStation && nexrad_locations[savedStation]) {
            const loc = nexrad_locations[savedStation];
            selectStation(savedStation, loc.type || 'WSR-88D');
        }
    });
}

function setStationMarkerStyle(useLegacyStyle) {
    if (!map.getSource('stationSymbolLayer')) return;

    const sourceData = map.getSource('stationSymbolLayer')._data;
    if (!sourceData || !sourceData.features) return;

    const updated = _copy(sourceData);
    for (let i = 0; i < updated.features.length; i++) {
        updated.features[i].properties.useLegacyStyle = !!useLegacyStyle;
    }
    map.getSource('stationSymbolLayer').setData(updated);
}

module.exports = showStations;
module.exports.selectStation = selectStation;
module.exports.setStationMarkerStyle = setStationMarkerStyle;