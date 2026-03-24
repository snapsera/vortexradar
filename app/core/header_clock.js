'use strict';

const { get_station_timezone } = require('../radar/libnexrad/nexrad_locations');

const TIME_FMT = { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true, timeZoneName: 'short' };

function _format(date, timeZone) {
    try {
        return date.toLocaleTimeString([], { ...TIME_FMT, timeZone });
    } catch (_) {
        return '--:--:--';
    }
}

function _tick() {
    const now = new Date();

    const localEl = document.getElementById('headerClockLocal');
    const siteEl = document.getElementById('headerClockSite');
    if (!localEl || !siteEl) return;

    localEl.textContent = _format(now);

    const station = window.stormTrackData?.currentStation;
    const tz = station ? get_station_timezone(station) : null;
    siteEl.textContent = tz ? _format(now, tz) : '--:--:--';
}

function init() {
    _tick();
    setInterval(_tick, 1000);
}

module.exports = { init };
