var map = require('../core/map/map');
const ut = require('../core/utils');
const get_polygon_colors = require('./colors/polygon_colors');
const display_app_dialog = require('../core/menu/app_dialog');
const chroma = require('chroma-js');
const { DateTime } = require('luxon');
const hash_string = require('./hash_string');
const MapPopup = require('../core/popup/MapPopup');
const alert_helpers = require('./alert_helpers');
const loaders_nexrad = require('../radar/libnexrad/loaders_nexrad');
const turf = require('@turf/turf');
const radar_scan_animation = require('../radar/station_markers/radar_scan_animation');
const settings_store = require('../core/menu/settings_store');

// https://stackoverflow.com/a/4878800/18758797
function to_title_case(str) {
    return str.replace(/\w\S*/g, function (txt) {
        return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
    });
}

function _fix_value(value, text_value_ID) {
    if (Array.isArray(value)) value = value[0];
    if (value === value.toUpperCase() && /^[a-zA-Z\s]*$/.test(value)) {
        value = to_title_case(value);
    }
    value = value.replaceAll('MPH', 'mph');
    if (text_value_ID === 'Hail:') value += '"';
    return value;
}

function _build_card_params(properties, parameters) {
    var parameters_html = '';
    function add_parameter(parameter_name, text_value_ID) {
        if (parameters.hasOwnProperty(parameter_name)) {
            var value = _fix_value(parameters[parameter_name], text_value_ID);
            if (properties.event === 'Severe Thunderstorm Warning') {
                if (parameter_name === 'maxHailSize' && parameters.hasOwnProperty('hailThreat')) {
                    value += `, ${_fix_value(parameters['hailThreat'])}`;
                }
                if (parameter_name === 'maxWindGust' && parameters.hasOwnProperty('windThreat')) {
                    value += `, ${_fix_value(parameters['windThreat'])}`;
                }
            }
            parameters_html += `<div><span class="alert_popup_lessertext">${text_value_ID}</span> <b>${value}</b></div>`;
        }
    }
    add_parameter('tornadoDetection', 'Tornado:');
    add_parameter('waterspoutDetection', 'Waterspout:');
    add_parameter('flashFloodDamageThreat', 'Damage Threat:');
    add_parameter('flashFloodDetection', 'Source:');
    add_parameter('maxHailSize', 'Hail:');
    add_parameter('maxWindGust', 'Wind:');
    return parameters_html;
}

function _format_expires(properties) {
    var alertExpiresTime = properties.ends || properties.expires;
    if (!alertExpiresTime) return '';
    var expiresTime = DateTime.fromISO(alertExpiresTime).toUTC().toJSDate();
    var currentTime = DateTime.now().toUTC().toJSDate();
    const dateDiff = ut.getDateDiff(currentTime, expiresTime);
    var formattedDateDiff;
    var thingToPrepend = 'Expires in ...';
    var thingToAppend = '';
    if (dateDiff.s) formattedDateDiff = `${dateDiff.s}s`;
    if (dateDiff.m) formattedDateDiff = `${dateDiff.m} mins.`;
    if (dateDiff.h) formattedDateDiff = `${dateDiff.h}h ${dateDiff.m || 0}m`;
    if (dateDiff.d) formattedDateDiff = `${dateDiff.d}d ${dateDiff.h}h`;
    if (dateDiff.negative) {
        thingToPrepend = 'Expired:';
        thingToAppend = ' ago';
    }
    return `${thingToPrepend} <b>${formattedDateDiff}</b>${thingToAppend}`;
}

function _select_radar_and_fly(station, feature) {
    if (!station) return;
    window.stormTrackData.currentStation = station;
    $('#radarStation').html(station);
    const nexrad_locations = require('../radar/libnexrad/nexrad_locations').NEXRAD_LOCATIONS;
    $('#radarLocation').html(nexrad_locations[station]?.name || '');
    const productToLoad = 'N0B';
    $('#wsr88d_psm').show();
    $('#tdwr_psm').hide();
    $('#level2_psm').hide();
    $('#productsDropdownTriggerText').html(window.longProductNames?.['ref'] || 'Reflectivity');
    $('#radarInfoSpan').show();
    window.stormTrackData.from_file_upload = false;
    loaders_nexrad.quick_level_3_plot(station, productToLoad, () => {});
    var sweepEnabled = settings_store.load().radarSweep;
    if (sweepEnabled !== false) {
        radar_scan_animation.update(station);
    }
    if (feature && feature.geometry) {
        try {
            const bbox = turf.bbox(feature.geometry);
            map.fitBounds(bbox, { padding: 40, maxZoom: 8, duration: 800 });
        } catch (_) {}
    }
}

function click_listener(e) {
    e.originalEvent.cancelBubble = true;

    const renderedFeatures = map.queryRenderedFeatures(e.point);
    if (renderedFeatures[0] && renderedFeatures[0].layer.id === 'stationSymbolLayer') return;

    const lng = e.lngLat.lng;
    const lat = e.lngLat.lat;
    const alertContentObj = {};
    const alreadyAddedAlerts = [];
    const cards = [];

    const alertFillLayers = ['alertsLayerFill', 'watches_layer_fill'].filter((id) => map.getLayer(id));
    const allFeatures = alertFillLayers.length > 0
        ? map.queryRenderedFeatures(e.point, { layers: alertFillLayers })
        : e.features;

    for (var key = 0; key < allFeatures.length; key++) {
        const feature = allFeatures[key];
        var properties = JSON.parse(JSON.stringify(feature.properties));
        var parameters = JSON.parse(properties.parameters || '{}');
        delete properties.type;

        const hash = hash_string(JSON.stringify(properties));
        if (alreadyAddedAlerts.includes(hash)) continue;
        alreadyAddedAlerts.push(hash);

        const id = `popup_${hash}alert`;
        const initColor = get_polygon_colors(properties.event).color;
        const parameters_html = _build_card_params(properties, parameters);
        const expiresStr = _format_expires(properties);
        const body = alert_helpers.build_full_alert_body(properties);

        alertContentObj[id] = {
            title: properties.event,
            body: body,
            color: initColor,
            textColor: chroma(initColor).luminance() > 0.4 ? 'black' : 'white',
            feature: feature
        };

        const hexColor = chroma(initColor).hex();
        const cardHtml = `
<div class="alertPopupCard" data-id="${id}">
  <div class="alertPopupCardHeader" style="background: ${hexColor}">${properties.event}</div>
  <div class="alertPopupCardBody">
    ${parameters_html}
    ${expiresStr ? `<div class="alert_popup_lessertext">${expiresStr}</div>` : ''}
    <div class="alertPopupCardActions">
      <button type="button" class="alertPopupBtn alertPopupGlobe" title="Select closest radar"><span class="fa fa-globe"></span></button>
      <button type="button" class="alertPopupBtn alertPopupArrow" title="View details"><span class="fa fa-chevron-right"></span></button>
    </div>
  </div>
</div>`;
        cards.push(cardHtml);
    }

    if (cards.length === 0) return;

    const popup_html = `<div class="alertPopupCards">${cards.join('')}</div>`;
    const popup = new MapPopup(e.lngLat, popup_html);
    popup.add_to_map();
    popup.map_popup_div.addClass('alertPopupCardsContainer');
    popup.update_popup_pos();

    popup.map_popup_div.find('.alertPopupGlobe').on('click', function (ev) {
        ev.stopPropagation();
        const card = $(this).closest('.alertPopupCard');
        const id = card.data('id');
        const data = alertContentObj[id];
        if (!data) return;
        const station = alert_helpers.get_closest_wsr88d_radar(lng, lat);
        _select_radar_and_fly(station, data.feature);
        popup.remove();
    });

    popup.map_popup_div.find('.alertPopupArrow').on('click', function (ev) {
        ev.stopPropagation();
        const card = $(this).closest('.alertPopupCard');
        const id = card.data('id');
        const data = alertContentObj[id];
        if (!data) return;
        display_app_dialog({
            title: data.title,
            body: data.body,
            color: data.color,
            textColor: data.textColor
        });
        popup.remove();
    });

}

module.exports = click_listener;
