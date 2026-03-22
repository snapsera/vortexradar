/**
 * Re-filters and updates alert layers based on Alerts Display settings.
 */
const filter_alerts = require('./filter_alerts');
const plot_alerts = require('./plot_alerts');
const combine_dictionary_data = require('./combine_dictionary_data');
const fetch_discussions = require('./discussions/discussions');
const watch_overlay = require('./watch_overlay');

const APPLY_DEBOUNCE_MS = 32;
let _applyAlertsDisplayTimer = null;

function _deep_clone(data) {
    return JSON.parse(JSON.stringify(data));
}

function _record_perf(durationMs) {
    if (typeof window === 'undefined' || !window.stormTrackData) return;
    const perf = window.stormTrackData.perf = window.stormTrackData.perf || {};
    perf.applyAlertsDisplayCalls = (perf.applyAlertsDisplayCalls || 0) + 1;
    perf.applyAlertsDisplayLastMs = durationMs;
}

function _run_apply_alerts_display() {
    const start = performance.now();
    const data = window.stormTrackData?.alerts_data;
    if (data) {
        let toPlot;
        const zonesLoaded = typeof window !== 'undefined' && typeof window.forecast_zones !== 'undefined';
        if (zonesLoaded) {
            toPlot = combine_dictionary_data(_deep_clone(data));
        } else {
            // Keep window.stormTrackData.alerts_data immutable in this path.
            toPlot = _deep_clone(data);
        }
        const filtered = filter_alerts(toPlot);
        plot_alerts(filtered);
    }
    if (fetch_discussions.apply_discussions_display) fetch_discussions.apply_discussions_display();
    watch_overlay.update_from_alerts_data(data);
    _record_perf(performance.now() - start);
}

function apply_alerts_display() {
    if (_applyAlertsDisplayTimer) {
        clearTimeout(_applyAlertsDisplayTimer);
    }
    _applyAlertsDisplayTimer = setTimeout(() => {
        _applyAlertsDisplayTimer = null;
        _run_apply_alerts_display();
    }, APPLY_DEBOUNCE_MS);
}

module.exports = { apply_alerts_display };
