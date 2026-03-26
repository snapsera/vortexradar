/**
 * Floating warning counter overlay — shows live counts of
 * Severe Thunderstorm Warnings and Tornado Warnings.
 */
const settings_store = require('../core/menu/settings_store');

const TORNADO_EVENTS = ['Tornado Warning', 'PDS Tornado Warning', 'Tornado Emergency'];
const SVR_EVENTS = ['Severe Thunderstorm Warning'];

let _prevSvr = -1;
let _prevTor = -1;

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

    _refresh();
}

module.exports = { init };
