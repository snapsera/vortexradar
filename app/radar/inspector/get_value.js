const turf = require('@turf/turf');
const format_value = require('./format_value');
const product_colors = require('../colormaps/colormaps');

function beam_height(distance_km, elevation_meters, elevation_angle) {
    var elevation = elevation_meters; // m
    var height = elevation / 1000; // km
    height = 0; // because we're doing ARL, not MSL
    var range = distance_km; // km
    var elevAngle = elevation_angle; // 0.5;
    var earthRadius = 6374; // km

    const radians = Math.PI / 180;

    /*
    // // Calculates the beam height MSL (mean sea level (this means above sea level)) in km.
    * Calculates the beam height ARL (above radar level) in ft.
    * Formula taken from https://wx.erau.edu/faculty/mullerb/Wx365/Doppler_formulas/doppler_formulas.pdf
    */
    var beamHeightARL = Math.sqrt(
        Math.pow(range, 2)
        +
        Math.pow((4/3) * earthRadius + height, 2)
        +
        (2*range)*((4/3) * earthRadius + height)
        *
        Math.sin(elevAngle * radians)
    ) - (4/3) * earthRadius;

    function km_to_kft(km) { return km * 3.28084 }
    function km_to_miles(km) { return km * 1.609 }
    function km_to_ft(km) { return km * 3280.8 }

    // var beamHeightKFT = km_to_kft(beamHeightMSL);
    // var beamHeightMI = km_to_miles(beamHeightMSL);
    var beamHeightFT = km_to_ft(beamHeightARL);

    return beamHeightFT;
}

function readPixels(gl, x, y) {
    var data = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return data;
}

// https://stackoverflow.com/a/73854666/18758797
function getValue(e) {
    const canvas = map.getCanvas();
    const gl = canvas.getContext('webgl') || canvas.getContext('webgl2');

    if (gl) {
        // canvas width and height is what you see on the screen
        const canvasWidth = parseFloat(canvas.style.width, 10);
        const canvasHeight = parseFloat(canvas.style.height, 10);

        var canvasX, canvasY;
        if (e && e.x !== undefined && e.y !== undefined) {
            canvasX = e.x;
            canvasY = e.y;
        } else {
            var mapCenter = map.project(map.getCenter());
            canvasX = mapCenter.x;
            canvasY = mapCenter.y;
        }

        // WebGL buffer is larger than canvas, there 
        const bufferX = (gl.drawingBufferWidth / canvasWidth * canvasX).toFixed(0);
        const bufferY = (gl.drawingBufferHeight / canvasHeight * (canvasHeight - canvasY)).toFixed(0);

        gl.bindFramebuffer(gl.FRAMEBUFFER, window.stormTrackData.fb);
        var data = readPixels(gl, bufferX, bufferY);

        const cmin = window.stormTrackData.cmin;
        const cmax = window.stormTrackData.cmax;
        var value, orig_value;
        if (cmin != undefined) {
            [value, orig_value] = format_value.decode_and_format(data, cmin, cmax);
            if (value == null) {
                $('#colorPickerText').hide();
            } else {
                $('#colorPickerText').show();
            }
            $('#colorPickerTextValue').text(value);
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        var [r, g, b, a] = readPixels(gl, bufferX, bufferY);
        var color = `rgba(${r}, ${g}, ${b}, ${a})`;
        if (color != 'rgba(0, 0, 0, 0)') {
            var color_to_show;
            if (window.stormTrackData.webgl_chroma_scale != undefined) {
                const [r2, g2, b2, a2] = window.stormTrackData.webgl_chroma_scale(parseFloat(orig_value)).rgba();
                color_to_show = `rgba(${r2}, ${g2}, ${b2}, ${a2})`;
            } else {
                color_to_show = color;
            }
            if (value == null) {
                color_to_show = color;
            }
            if (value == 'Range Folded') {
                color_to_show = product_colors.range_folded;
            }
            $('#colorPicker').css('background-color', color_to_show);
        }

        const radar_location = window.stormTrackData.current_nexrad_location;
        if (radar_location != undefined) {
            const cursorLngLat = map.unproject({ x: canvasX, y: canvasY });
            const cursor_formatted = turf.point([cursorLngLat.lng, cursorLngLat.lat]);
            const radar_location_formatted = turf.point([radar_location[1], radar_location[0]]);
            const bearing = turf.bearing(cursor_formatted, radar_location_formatted);

            $('#radarCenterLine').css({
                '-webkit-transform': `rotate(${bearing}deg)`,
                '-moz-transform': `rotate(${bearing}deg)`,
                'transform': `rotate(${bearing}deg)` /* For modern browsers(CSS3)  */
            });

            const current_elevation_angle = window.stormTrackData.current_elevation_angle;
            const distance_from_radar = turf.distance(cursor_formatted, radar_location_formatted, { units: 'kilometers' });
            const beam_height_calculated = beam_height(distance_from_radar, radar_location[2], current_elevation_angle);
            $('#colorPickerTextBeamHeight').text(`${beam_height_calculated.toFixed(0)} ft ARL`);
        }
    }
}

module.exports = getValue;