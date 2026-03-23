const ut = require('../../core/utils');
const kmz_to_geojson = require('../../hurricanes/kmz_to_geojson');
const get_polygon_colors = require('../colors/polygon_colors');
const turf = require('@turf/turf');
const map = require('../../core/map/map');
const set_layer_order = require('../../core/map/setLayerOrder');
const MapPopup = require('../../core/popup/MapPopup');
const display_app_dialog = require('../../core/menu/app_dialog');
const alerts_display_state = require('../alerts_display_state');

const all_discussions_url = `https://www.spc.noaa.gov/products/md/ActiveMD.kmz`; // https://www.spc.noaa.gov/products/md/ActiveMD.kmz

function _filter_discussions(features) {
    if (!alerts_display_state.get_mesoscale_enabled()) return [];
    return features;
}
// const all_discussions_url = `http://localhost:3333/ActiveMD.kmz`

function click_listener(e) {
    if (e.originalEvent.cancelBubble) { return; }
    const renderedFeatures = map.queryRenderedFeatures(e.point);
    if (renderedFeatures[0] && renderedFeatures[0].layer.id == 'stationSymbolLayer') return;
    const properties = e.features[0].properties;
    const divid = `md${properties.id}`

    var popup_html =
`<div style="font-weight: bold; font-size: 13px;">Mesoscale Discussion ${properties.id}</div>
<i id="${divid}" class="alert_popup_info icon-blue fa fa-circle-info" style="color: rgb(255, 255, 255);"></i>`;

    const popup = new MapPopup(e.lngLat, popup_html);
    popup.add_to_map();
    popup.map_popup_div.width(`+=${$('.alert_popup_info').outerWidth() + parseInt($('.alert_popup_info').css('paddingRight'))}`);
    popup.update_popup_pos();

    $(`#${divid}`).on('click', function() {
        display_app_dialog({
            'title': `Mesoscale Discussion ${properties.id}`,
            'body': properties.full_desc,
            'color': properties.color,
            'textColor': 'white',
        })
    })
}

function _fetch_individual_discussion(url, callback) {
    fetch(url, { cache: 'no-store' })
    .then(response => {
        if (!response.ok) throw new Error(`Discussion fetch ${response.status}`);
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
    .catch(err => console.error('Failed to fetch individual discussion:', err))
}

function _plot_discussions(feature_collection) {
    const filtered = _filter_discussions(feature_collection.features);
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

    if (map.getSource('discussions_source')) {
        map.getSource('discussions_source').setData(fc);
    } else {
        const fillOpacity = (window.stormTrackData && window.stormTrackData.alertFillOpacity != null) ? window.stormTrackData.alertFillOpacity : 0.1;
        const bScale = (window.stormTrackData && window.stormTrackData.alertBorderScale != null) ? window.stormTrackData.alertBorderScale : 0.75;
        map.addSource(`discussions_source`, {
            type: 'geojson',
            data: fc,
        })
        map.addLayer({
            'id': 'discussions_layer_border',
            'type': 'line',
            'source': 'discussions_source',
            'filter': ['==', ['get', 'type'], 'border'],
            'paint': {
                'line-color': 'black',
                'line-width': 7 * bScale
            }
        });
        map.addLayer({
            'id': `discussions_layer`,
            'type': 'line',
            'source': `discussions_source`,
            'filter': ['==', ['get', 'type'], 'outline'],
            'layout': { 'line-cap': 'butt' },
            'paint': {
                'line-color': ['get', 'color'],
                'line-width': 3 * bScale,
                'line-dasharray': [4, 3]
            }
        });
        map.addLayer({
            'id': `discussions_layer_fill`,
            'type': 'fill',
            'source': `discussions_source`,
            paint: {
                'fill-color': ['get', 'color'],
                'fill-opacity': fillOpacity
            }
        });

        map.on('mouseover', `discussions_layer_fill`, function(e) {
            map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseout', `discussions_layer_fill`, function(e) {
            map.getCanvas().style.cursor = '';
        });
        map.on('click', `discussions_layer_fill`, click_listener);

        set_layer_order();
    }
}

const features = [];
function fetch_discussions() {
    fetch(all_discussions_url, { cache: 'no-store' })
    .then(response => {
        if (!response.ok) throw new Error(`ActiveMD fetch ${response.status}`);
        return response.blob();
    })
    .then(blob => {
        blob.lastModifiedDate = new Date();
        blob.name = all_discussions_url;

        kmz_to_geojson(blob, (kml_dom) => {
            const parsed_xml = ut.xmlToJson(kml_dom);
            let base;
            try {
                base = parsed_xml.kml.Document.Folder.NetworkLink;
            } catch (_) { return; }
            if (!base) { return; }

            const links = Array.isArray(base) ? base : [base];
            for (var i = 0; i < links.length; i++) {
                const this_discussion_url = links[i].Link.href['#text'];
                const this_discussion_desc = links[i].name['#text'];

                const id_match = this_discussion_desc.match(/(\d+)/);
                if (!id_match) continue;
                const id = id_match[1];

                _fetch_individual_discussion(this_discussion_url, (geojson) => {
                    geojson.features[0].properties.event = this_discussion_desc;
                    geojson.features[0].properties.color = 'rgb(0, 0, 245)';
                    geojson.features[0].properties.id = id;

                    fetch(`https://www.spc.noaa.gov/products/md/md${id}.html`)
                    .then(response => {
                        if (!response.ok) throw new Error(`MD HTML fetch ${response.status}`);
                        return response.text();
                    })
                    .then(text => {
                        const doc = new DOMParser().parseFromString(text, 'text/html');
                        const preElems = doc.querySelectorAll('pre');
                        const full_desc = preElems.length > 0 ? preElems[0].innerHTML : '';
                        geojson.features[0].properties.full_desc = full_desc;

                        features.push(geojson.features[0]);
                        window.stormTrackData.discussions_data = turf.featureCollection([...features]);
                        _plot_discussions(window.stormTrackData.discussions_data);
                    })
                    .catch(err => console.error(`Failed to fetch MD ${id} text:`, err))
                })
            }
        }, true);
    })
    .catch(err => console.error('Failed to fetch mesoscale discussions:', err))
}

function apply_discussions_display() {
    const data = window.stormTrackData?.discussions_data;
    if (!data || !map.getSource('discussions_source')) return;
    _plot_discussions(data);
}

module.exports = fetch_discussions;
module.exports.apply_discussions_display = apply_discussions_display;