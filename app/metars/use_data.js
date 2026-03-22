var map = require('../core/map/map');
const ut = require('../core/utils');
const display_app_dialog = require('../core/menu/app_dialog');
const getTempColor = require('../core/misc/temp_colors');
const chroma = require('chroma-js');
const metarParser = require('aewx-metar-parser');

var geojsonTemplate = {
    "type": "FeatureCollection",
    "features": []
}
function resetTemplate() {
    geojsonTemplate = {
        "type": "FeatureCollection",
        "features": []
    }
}

function useData(data) {
    resetTemplate();
    for (var item in data.response.data.METAR) {
        if (data.response.data.METAR[item].hasOwnProperty('latitude')) {
            var lat = parseFloat(data.response.data.METAR[item].latitude['#text']);
            var lon = parseFloat(data.response.data.METAR[item].longitude['#text']);
            var stationId = data.response.data.METAR[item].station_id['#text'];
            var rawMetarText = data.response.data.METAR[item].raw_text['#text'];

            try {
                var parsedMetarData = metarParser(rawMetarText);
                var parsedMetarTemp = parseInt(ut.CtoF(parsedMetarData.temperature.celsius));
                var tempColor = getTempColor(parsedMetarTemp);

                geojsonTemplate.features.push({
                    'properties': {
                        'stationID': stationId,
                        'rawMetarText': rawMetarText,
                        'temp': parsedMetarTemp,
                        'tempColor': tempColor[0],
                        'tempColorText': tempColor[1],
                    },
                    "geometry": {
                        "type": "Point",
                        "coordinates":
                            [lon, lat]
                    }
                });
            }
            catch(err) {}
        }
    }

    map.addSource('metarSymbolLayer', {
        'type': 'geojson',
        'generateId': true,
        'data': geojsonTemplate
    });

    map.addLayer({
        'id': 'metarSymbolLayer',
        'type': 'symbol',
        'source': 'metarSymbolLayer',
        'layout': {
            'icon-image': ['get', 'temp'],
            'icon-size': 0.15,
        },
    });
    map.moveLayer('stationSymbolLayer');

    map.on('click', 'metarSymbolLayer', (e) => {
        const coordinates = e.features[0].geometry.coordinates.slice();
        const id = e.features[0].properties.stationID;
        const rawText = e.features[0].properties.rawMetarText;

        var parsedMetarData = metarParser(rawText);

        try {
            var metarTemp = parsedMetarData.temperature.celsius;
            var parsedMetarTemp = parseInt(ut.CtoF(metarTemp));
            var metarDewPoint = parsedMetarData.dewpoint.celsius;
            var metarBarometer = parsedMetarData.barometer.hg;
            var metarVisibility = parsedMetarData.visibility.miles;
            var metarWindSpeed = parsedMetarData.wind.speed_kts;
            var metarWindGustSpeed = parsedMetarData.wind.gust_kts;
            var metarWindDirection = parsedMetarData.wind.degrees;
            if (metarWindDirection == null) {
                metarWindDirection = 0;
            }
            var metarFancyTime = ut.printFancyTime(parsedMetarData.observed);

            var tempColor = getTempColor(parsedMetarTemp);

            var metarHTMLBody = 
`<div style="text-align: center; font-size: 30px; color: ${tempColor[1]}; background-color: ${tempColor[0]}"><b>${parsedMetarTemp}</b> °F</div>
<i><b>VALID: </b>${metarFancyTime}</i>
<b>Dew Point: </b>${parseInt(ut.CtoF(metarDewPoint))} °F
<b>Barometer: </b>${metarBarometer} inHG
<b>Visibility: </b>${metarVisibility} miles

<b>Wind:</b>
${ut.knotsToMph(metarWindSpeed, 0)} mph
${ut.knotsToMph(metarWindGustSpeed, 0)} mph gusts
${metarWindDirection}° (${ut.degToCompass(metarWindDirection)})
<b>Raw Text: </b><u>${rawText}</u>`

            display_app_dialog({
                'title': `Station ${id}`,
                'body': metarHTMLBody,
                'color': 'rgb(19, 19, 19)',
                'textColor': 'white'
            });
        } catch(err) {
            var headerColor = '#ba3043';
            display_app_dialog({
                'title': `Station ${id}: Error`,
                'color': headerColor,
                'textColor': chroma(headerColor).luminance() > 0.4 ? 'black' : 'white',
                'body': 
`There was an error parsing the ${id} station's METAR data.

<b>Raw Text:</b>
<i>${rawText}</i>

<b>Error message:</b>
${err.message}`
            })
            console.warn(err.message);
        }
    });
    map.on('mouseenter', 'metarSymbolLayer', () => {
        map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'metarSymbolLayer', () => {
        map.getCanvas().style.cursor = '';
    });
}

function toggleMETARStationMarkers(showHide) {
    if (showHide == 'hide') {
        map.setLayoutProperty('metarSymbolLayer', 'visibility', 'none');
    } else if (showHide == 'show') {
        map.setLayoutProperty('metarSymbolLayer', 'visibility', 'visible');
    }
}

module.exports = {
    useData,
    toggleMETARStationMarkers
}
