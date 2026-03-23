/**
 * Floating warning counter overlay — shows live counts of
 * Severe Thunderstorm Warnings, Tornado Warnings, and the
 * current SPC Day 1 categorical risk level.
 */
const settings_store = require('../core/menu/settings_store');

const TORNADO_EVENTS = ['Tornado Warning', 'PDS Tornado Warning', 'Tornado Emergency'];
const SVR_EVENTS = ['Severe Thunderstorm Warning'];

const SPC_DAY1_URL = 'https://www.spc.noaa.gov/products/outlook/day1otlk_cat.lyr.geojson';

const SPC_RISK_LEVELS = [
    { dn: 3, label: 'MARGINAL',  level: 1, color: '#73B273' },
    { dn: 4, label: 'SLIGHT',    level: 2, color: '#F7F78F' },
    { dn: 5, label: 'ENHANCED',  level: 3, color: '#E69800' },
    { dn: 6, label: 'MODERATE',  level: 4, color: '#FF0000' },
    { dn: 8, label: 'HIGH',      level: 5, color: '#FF00C5' },
];

let _cachedSpcRisk = null;
let _prevSvr = -1;
let _prevTor = -1;
let _prevSpcLevel = -1;

function _trigger_shine(el) {
    if (!el) return;
    el.classList.remove('warningCounterRow-shine');
    void el.offsetWidth;
    el.classList.add('warningCounterRow-shine');
}

function _count_warnings(features) {
    let tor = 0;
    let svr = 0;
    if (!features) return { tor, svr };
    for (const f of features) {
        const event = f?.properties?.event;
        if (!event) continue;
        if (TORNADO_EVENTS.includes(event)) tor++;
        else if (SVR_EVENTS.includes(event)) svr++;
    }
    return { tor, svr };
}

function _fetch_spc_risk() {
    fetch(SPC_DAY1_URL)
        .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(geojson => {
            let highest = null;
            for (const f of (geojson?.features || [])) {
                const dn = f?.properties?.DN;
                if (dn == null) continue;
                const entry = SPC_RISK_LEVELS.find(r => r.dn === dn);
                if (!entry) continue;
                if (!highest || entry.level > highest.level) highest = entry;
            }
            _cachedSpcRisk = highest;
            _refresh();
        })
        .catch(() => {});
}

function _refresh() {
    const overlay = document.getElementById('warningCounterOverlay');
    if (!overlay) return;

    const enabled = $('#armrWarningCounterBtnSwitchElem').is(':checked');
    if (!enabled) {
        overlay.style.display = 'none';
        return;
    }

    const features = window.stormTrackData?.alerts_data?.features;
    const { tor, svr } = _count_warnings(features);

    document.getElementById('warningCounterSvr').textContent = svr;
    document.getElementById('warningCounterTor').textContent = tor;

    if (svr !== _prevSvr && _prevSvr !== -1) {
        _trigger_shine(document.querySelector('.warningCounterRow-svr'));
    }
    if (tor !== _prevTor && _prevTor !== -1) {
        _trigger_shine(document.querySelector('.warningCounterRow-tor'));
    }
    _prevSvr = svr;
    _prevTor = tor;

    const spcRow = document.getElementById('warningCounterSpcRow');
    const spcName = document.getElementById('warningCounterSpcName');
    const spcLevel = document.getElementById('warningCounterSpcLevel');

    if (_cachedSpcRisk) {
        const newLevel = _cachedSpcRisk.level;
        spcRow.style.display = '';
        spcRow.style.background = _cachedSpcRisk.color;
        spcName.textContent = _cachedSpcRisk.label.charAt(0) + _cachedSpcRisk.label.slice(1).toLowerCase();
        spcLevel.textContent = newLevel + '/5';
        if (newLevel !== _prevSpcLevel && _prevSpcLevel !== -1) {
            _trigger_shine(spcRow);
        }
        _prevSpcLevel = newLevel;
    } else {
        spcRow.style.display = 'none';
    }

    overlay.style.display = '';
}

function init() {
    const saved = settings_store.load();
    if (saved.warningCounter) {
        $('#armrWarningCounterBtnSwitchElem').prop('checked', true);
    }

    $('#armrWarningCounterMainBtn, #armrWarningCounterBtnSwitchElem').on('click', function (e) {
        if (!$(e.target).is('#armrWarningCounterBtnSwitchElem')) {
            const cb = $('#armrWarningCounterBtnSwitchElem');
            cb.prop('checked', !cb.is(':checked'));
        }
        const s = settings_store.get_settings_from_dom();
        settings_store.save(s);
        _refresh();
    });

    $(document).on('alertsDataLoaded', function () {
        _refresh();
    });

    _fetch_spc_risk();
    setInterval(_fetch_spc_risk, 10 * 60 * 1000);

    _refresh();
}

module.exports = { init };
