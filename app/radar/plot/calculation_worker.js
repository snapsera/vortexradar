const CheapRuler = require('cheap-ruler');
const dest_vincenty = require('./dest_vincenty');

module.exports = function (self) {
    self.addEventListener('message', function (ev) {
        function mc(coords) {
            function mercatorXfromLng(lng) {
                return (180 + lng) / 360;
            }
            function mercatorYfromLat(lat) {
                return (180 - (180 / Math.PI * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)))) / 360;
            }
            return [mercatorXfromLng(coords[0]), mercatorYfromLat(coords[1])];
        }

        function projectPoints(points, lngLat) {
            var ruler = new CheapRuler(lngLat.lat, 'kilometers');
            for (var i = 0; i < points.length; i += 2) {
                var az = points[i];
                var distance = points[i + 1];
                var calc;
                if (distance == 0) {
                    calc = mc(ruler.destination([lngLat.lng, lngLat.lat], distance, az));
                } else {
                    calc = mc(dest_vincenty({lng: lngLat.lng, lat: lngLat.lat}, distance * 1000, az));
                }
                points[i] = calc[0];
                points[i + 1] = calc[1];
            }
            return points;
        }

        if (ev.data && ev.data.mode === 'build_and_project') {
            var azimuths = ev.data.azimuths;
            var ranges = ev.data.ranges;
            var flatData = ev.data.data;
            var dataWidth = ev.data.dataWidth;
            var lngLat = ev.data.lngLat;
            var numAz = azimuths.length;
            var numRanges = ranges.length;

            var total = 0;
            for (var i = 0; i < numAz - 1; i++) {
                for (var n = 0; n < numRanges - 1; n++) {
                    if (!isNaN(flatData[i * dataWidth + n])) total++;
                }
            }

            var points = new Float32Array(total * 12);
            var colors = new Float32Array(total * 6);
            var pi = 0;
            var ci = 0;

            for (var i = 0; i < numAz - 1; i++) {
                for (var n = 0; n < numRanges - 1; n++) {
                    var val = flatData[i * dataWidth + n];
                    if (!isNaN(val)) {
                        var az0 = azimuths[i], az1 = azimuths[i + 1];
                        var r0 = ranges[n], r1 = ranges[n + 1];
                        points[pi++] = az0; points[pi++] = r0;
                        points[pi++] = az0; points[pi++] = r1;
                        points[pi++] = az1; points[pi++] = r0;
                        points[pi++] = az1; points[pi++] = r0;
                        points[pi++] = az0; points[pi++] = r1;
                        points[pi++] = az1; points[pi++] = r1;

                        colors[ci++] = val; colors[ci++] = val; colors[ci++] = val;
                        colors[ci++] = val; colors[ci++] = val; colors[ci++] = val;
                    }
                }
            }

            points = projectPoints(points, lngLat);
            self.postMessage({ vertices: points, colors: colors }, [points.buffer, colors.buffer]);
        } else {
            var points = ev.data[0];
            var lngLat = ev.data[1];
            projectPoints(points, lngLat);
            self.postMessage(points);
        }
    })
}
