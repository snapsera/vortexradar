const map = require('./map/map');

const el = document.getElementById('cursorCoords');

function format(deg, posChar, negChar) {
    const abs = Math.abs(deg);
    const dir = deg >= 0 ? posChar : negChar;
    return abs.toFixed(4) + '° ' + dir;
}

map.on('mousemove', function (e) {
    const { lng, lat } = e.lngLat;
    el.textContent = format(lat, 'N', 'S') + ',  ' + format(lng, 'E', 'W');
    el.classList.add('cursorCoords-visible');
});

map.getCanvas().addEventListener('mouseleave', function () {
    el.classList.remove('cursorCoords-visible');
});
