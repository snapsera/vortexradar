var noaa_colors = require('./noaa_colors');

// these are custom colors that override noaa's colors
const my_polygon_colors = {
    'Tornado Watch': 'rgb(245, 0, 220)',
    'Tornado Warning': 'rgb(245, 0, 220)',
    'PDS Tornado Warning': 'rgb(245, 0, 220)',
    'Tornado Emergency': 'rgb(245, 0, 220)',
    'Severe Thunderstorm Watch': 'rgb(128, 128, 38)',
    'STP Watch': 'rgb(255, 255, 255)'


    // 'Tornado Warning': 'rgb(233, 51, 35)',
    // 'Severe Thunderstorm Warning': 'rgb(244, 185, 65)',
    // 'Flood Warning': 'rgb(147, 241, 75)',
    // 'Flash Flood Warning': 'rgb(147, 241, 75)',
    // 'Special Marine Warning': 'rgb(197, 155, 249)',
    // 'Special Weather Statement': 'rgb(151, 204, 230)',

    // 'Tornado Watch': 'rgb(245, 254, 83)',
    // 'Severe Thunderstorm Watch': 'rgb(238, 135, 134)',
    // 'Flood Watch': 'rgb(58, 111, 29)',
    // 'Flash Flood Watch': 'rgb(58, 111, 29)',

    // 'Hurricane Warning': 'rgb(199, 63, 155)',
    // 'Tropical Storm Warning': 'rgb(251, 231, 88)',
    // 'Storm Surge Warning': 'rgb(76, 87, 246)',
    // 'Hurricane Watch': 'rgb(234, 51, 247)',
    // 'Tropical Storm Watch': 'rgb(239, 127, 131)',
    // 'Storm Surge Watch': 'rgb(165, 202, 182)',

    // 'Blizzard Warning': 'rgb(235, 78, 65)',
    // 'Winter Storm Warning': 'rgb(240, 141, 233)',
    // 'Ice Storm Warning': 'rgb(173, 74, 248)',
    // 'Snow Squall Warning': 'rgb(3, 0, 163)',
    // 'Winter Weather Advisory': 'rgb(167, 129, 249)',
    // 'Blizzard Watch': 'rgb(234, 254, 89)',
    // 'Winter Storm Watch': 'rgb(57, 129, 247)',

    // 'Small Craft Advisory': 'rgb(109, 186, 150)',
    // 'Gale Watch': 'rgb(102, 147, 255)',
    // 'Gale Warning': 'rgb(50, 111, 255)'
}

const _colorCache = new Map();

function get_polygon_colors(alert_event) {
    if (_colorCache.has(alert_event)) {
        return _colorCache.get(alert_event);
    }
    // var noaa_colors = require('./noaa_colors');
    // for (var item in noaa_colors) {
    //     delete noaa_colors[item].FIELD3;
    //     var unformattedRGB = noaa_colors[item].rgb2;
    //     var formattedRGB = unformattedRGB.split(' ');
    //     formattedRGB = `rgb(${formattedRGB[0]}, ${formattedRGB[1]}, ${formattedRGB[2]})`
    //     noaa_colors[item].rgb = formattedRGB;

    //     noaa_colors[item].hex = `#${noaa_colors[item].hex2}`;

    //     delete noaa_colors[item].rgb2;
    //     delete noaa_colors[item].hex2;
    // }
    // console.log(noaa_colors)
    // for (var item in noaa_colors) {
    //     if (myPolygonColors[item] != undefined) {
    //         noaa_colors[item].rgb = myPolygonColors[item];
    //         //noaa_colors[item].rgb = myPolygonColors[item];
    //     }
    // }
    // console.log(noaa_colors)

    const eventColor = noaa_colors[alert_event];
    if (eventColor) {
        var c = eventColor.rgb;
        if (eventColor.hasOwnProperty('originalColor')) {
            c = eventColor.rgb;
        }
        if (my_polygon_colors.hasOwnProperty(alert_event)) {
            c = my_polygon_colors[alert_event];
        }
        const result = {
            'color': c,
            'priority': eventColor.priority
        };
        _colorCache.set(alert_event, result);
        return result;
    } else if (my_polygon_colors.hasOwnProperty(alert_event)) {
        const result = {
            'color': my_polygon_colors[alert_event],
            'priority': '50'
        };
        _colorCache.set(alert_event, result);
        return result;
    } else {
        const result = {
            'color': 'rgb(128, 128, 128)',
            'priority': '999'
        };
        _colorCache.set(alert_event, result);
        return result;
    }
}

module.exports = get_polygon_colors;