const ut = require('../../core/utils');
const kmz_to_geojson = require('../../hurricanes/kmz_to_geojson');
const get_polygon_colors = require('../colors/polygon_colors');
const turf = require('@turf/turf');
const map = require('../../core/map/map');
const set_layer_order = require('../../core/map/setLayerOrder');
const MapPopup = require('../../core/popup/MapPopup');
const display_app_dialog = require('../../core/menu/app_dialog');
const alerts_display_state = require('../alerts_display_state');

const all_watches_url = `https://www.spc.noaa.gov/products/watch/ActiveWW.kmz`; // https://www.spc.noaa.gov/products/watch/ActiveWW.kmz
const WATCH_FILL_OPACITY = 0.15;

function _get_watch_event_type(eventStr) {
    // eventStr is like "Tornado Watch 123" or "Severe Thunderstorm Watch 456"
    const match = /(.*? Watch) \d+/.exec(eventStr);
    return match ? match[1] : eventStr;
}

function _filter_watches(features) {
    return features.filter((f) => {
        const eventType = _get_watch_event_type(f.properties.event || '');
        return alerts_display_state.get_alert_type_enabled(eventType);
    });
}

function click_listener(e) {
    // if (e.originalEvent.cancelBubble) { return; }
    // const popup = new MapPopup(e.lngLat, `<b><div>${e.features[0].properties.event}</div></b>`);
    // popup.add_to_map();

    if (e.originalEvent.cancelBubble) { return; }
    const renderedFeatures = map.queryRenderedFeatures(e.point);
    if (renderedFeatures[0] && renderedFeatures[0].layer.id == 'stationSymbolLayer') return;
    const properties = e.features[0].properties;
    const divid = `ww${properties.id}`

    var popup_html =
`<div style="font-weight: bold; font-size: 13px;">${properties.event}</div>
<i id="${divid}" class="alert_popup_info icon-blue fa fa-circle-info" style="color: rgb(255, 255, 255);"></i>`;

    const popup = new MapPopup(e.lngLat, popup_html);
    popup.add_to_map();
    popup.map_popup_div.width(`+=${$('.alert_popup_info').outerWidth() + parseInt($('.alert_popup_info').css('paddingRight'))}`);
    popup.update_popup_pos();

    $(`#${divid}`).on('click', function() {
        display_app_dialog({
            'title': `${properties.event}`,
            'body': properties.full_desc,
            'color': properties.color,
            'textColor': 'white',
        })
    })
}

function _fetch_individual_watch(url, callback) {
    fetch(url, { cache: 'no-store' })
    .then(response => {
        if (!response.ok) throw new Error(`Watch fetch ${response.status}`);
        return response.blob();
    })
    .then(blob => {
        blob.lastModifiedDate = new Date();
        blob.name = url;

        kmz_to_geojson(blob, (geojson) => {
            if (geojson && geojson.features && geojson.features.length > 0) {
                callback(geojson);
            }
        });
    })
    .catch(err => console.error('Failed to fetch individual watch:', err))
}

function _plot_watches(feature_collection) {
    const filtered = _filter_watches(feature_collection.features);
    var duplicate_features = filtered.flatMap((element) => [element, element]);
    duplicate_features = JSON.parse(JSON.stringify(duplicate_features));
    for (var i = 0; i < duplicate_features.length; i++) {
        if (i % 2 === 0) {
            duplicate_features[i].properties.type = 'border';
        } else {
            duplicate_features[i].properties.type = 'outline';
        }
    }
    const fc = turf.featureCollection(duplicate_features);

    if (map.getSource('watches_source')) {
        map.getSource('watches_source').setData(fc);
        if (map.getLayer('watches_layer')) {
            map.setLayoutProperty('watches_layer', 'visibility', 'none');
        }
        if (map.getLayer('watches_layer_fill')) {
            map.setPaintProperty('watches_layer_fill', 'fill-opacity', WATCH_FILL_OPACITY);
        }
    } else {
        map.addSource(`watches_source`, {
            type: 'geojson',
            data: fc,
        })
        map.addLayer({
            'id': `watches_layer_fill`,
            'type': 'fill',
            'source': `watches_source`,
            paint: {
                //#0080ff blue
                //#ff7d7d red
                'fill-color': ['get', 'color'],
                'fill-opacity': WATCH_FILL_OPACITY
            }
        });

        map.on('mouseover', `watches_layer_fill`, function(e) {
            map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseout', `watches_layer_fill`, function(e) {
            map.getCanvas().style.cursor = '';
        });
        map.on('click', `watches_layer_fill`, click_listener);

        set_layer_order();
    }
}

const features = [];
function fetch_watches() {
    fetch(all_watches_url, { cache: 'no-store' })
    .then(response => {
        if (!response.ok) throw new Error(`ActiveWW fetch ${response.status}`);
        return response.blob();
    })
    .then(blob => {
        blob.lastModifiedDate = new Date();
        blob.name = all_watches_url;

        kmz_to_geojson(blob, (kml_dom) => {
            const parsed_xml = ut.xmlToJson(kml_dom);
            let base;
            try {
                base = parsed_xml.kml.Folder.NetworkLink;
            } catch (_) { return; }
            if (!base) { return; }

            const links = Array.isArray(base) ? base : [base];
            for (var i = 0; i < links.length; i++) {
                const this_discussion_url = links[i].Link.href['#text'];
                const this_discussion_desc = links[i].name['#text'];
                const event_match = /(.*? Watch \d+).*/.exec(this_discussion_desc);
                if (!event_match) continue;
                const event = event_match[1];
                const color = get_polygon_colors(event.substring(0, event.lastIndexOf(' '))).color;

                const id_match = event.match(/(\d+)/);
                if (!id_match) continue;
                const id = id_match[1];

                _fetch_individual_watch(this_discussion_url, (geojson) => {
                    geojson.features[0].properties.event = event;
                    geojson.features[0].properties.color = color;
                    geojson.features[0].properties.id = id;

                    fetch(`https://www.spc.noaa.gov/products/watch/ww${id.padStart(4, '0')}.html`)
                    .then(response => {
                        if (!response.ok) throw new Error(`Watch HTML fetch ${response.status}`);
                        return response.text();
                    })
                    .then(text => {
                        const doc = new DOMParser().parseFromString(text, 'text/html');
                        const preElems = doc.querySelectorAll('pre');
                        const full_desc = preElems.length > 0 ? preElems[0].innerHTML : '';
                        geojson.features[0].properties.full_desc = full_desc;

                        features.push(geojson.features[0]);
                        window.stormTrackData.watches_data = turf.featureCollection([...features]);
                        _plot_watches(window.stormTrackData.watches_data);
                    })
                    .catch(err => console.error(`Failed to fetch watch ${id} text:`, err))
                })
            }
        }, true);
    })
    .catch(err => console.error('Failed to fetch watches:', err))
}

function apply_watches_display() {
    const data = window.stormTrackData?.watches_data;
    if (!data || !map.getSource('watches_source')) return;
    _plot_watches(data);
}

module.exports = fetch_watches;
module.exports.apply_watches_display = apply_watches_display;