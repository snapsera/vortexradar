const ut = require('../core/utils');
const load_images = require('./load_images');
const pako = require('pako');
const Papa = require('papaparse');
const metar_station_info = require('./data/metar_station_info');
var map = require('../core/map/map');

const metar_info_lookup = Papa.parse(metar_station_info, {
    header: true,
    dynamicTyping: true,
}).data;
const metar_info_by_station = new Map();
for (const row of metar_info_lookup) {
    if (row && row.station_id) {
        metar_info_by_station.set(row.station_id, row);
    }
}
function _get_metar_station_info(station_id) {
    return metar_info_by_station.get(station_id);
}

function xhrGzipFile(url, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.addEventListener('load', function () {
        cb(this.response);
    })
    xhr.send();
}

function fetchMETARData() {
    var url = 'https://aviationweather.gov/data/cache/metars.cache.xml.gz#';
    var noCacheURL = ut.preventFileCaching(ut.phpProxy + url);
    xhrGzipFile(noCacheURL, function(data) {
        var xml = pako.inflate(new Uint8Array(data), { to: 'string' });
        var parsedXMLData = ut.xmlToJson(xml);

        for (var item in parsedXMLData.response.data.METAR) {
            if (parsedXMLData.response.data.METAR[item].hasOwnProperty('latitude')) {
                var stationId = parsedXMLData.response.data.METAR[item].station_id['#text'];
                const current_metar_info = _get_metar_station_info(stationId);
                if (current_metar_info != undefined) {
                    const country = current_metar_info.country;

                    const allowed_countries = ['US', 'PR', 'GU', 'VI', 'AS'];
                    const only_USA = true;
                    if (only_USA) {
                        if (!allowed_countries.includes(country)) {
                            delete parsedXMLData.response.data.METAR[item];
                        }
                    }
                } else {
                    delete parsedXMLData.response.data.METAR[item];
                }
            }
        }

        load_images(parsedXMLData);
    })
}

module.exports = {
    fetchMETARData
}
