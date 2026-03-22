const plot_alerts = require('../alerts/plot_alerts');
const watch_overlay = require('../alerts/watch_overlay');
const armFunctions = require('../core/menu/stormTrackProMenu');
const settings_store = require('../core/menu/settings_store');

let _enabled = false;
let _channel = null;
let _blinkTimer = null;
let _expiryInterval = null;

function _is_enabled() {
    return _enabled;
}

function _replot() {
    const alertsData = window.stormTrackData && window.stormTrackData.alerts_data;
    if (!alertsData) return;
    const clone = JSON.parse(JSON.stringify(alertsData));
    plot_alerts(clone);
    watch_overlay.update_from_alerts_data(clone);
}

function _stop_blinking_on_test_alerts() {
    var features = window.stormTrackData.testAlertFeatures;
    if (!features || !features.length) return;
    var changed = false;
    for (var i = 0; i < features.length; i++) {
        if (features[i].properties && features[i].properties.blinking) {
            features[i].properties.blinking = false;
            changed = true;
        }
    }
    if (changed) _replot();
}

function _schedule_blink_stop() {
    if (_blinkTimer) clearTimeout(_blinkTimer);
    var s = settings_store.load();
    var durationMs = (s.alertBlinkDuration || 30) * 1000;
    _blinkTimer = setTimeout(function() {
        _blinkTimer = null;
        _stop_blinking_on_test_alerts();
    }, durationMs);
}

function _check_expiry() {
    var features = window.stormTrackData.testAlertFeatures;
    if (!features || !features.length) return;
    var now = Date.now();
    var remaining = [];
    for (var i = 0; i < features.length; i++) {
        var exp = features[i].properties && features[i].properties.expires;
        if (exp && new Date(exp).getTime() <= now) continue;
        remaining.push(features[i]);
    }
    if (remaining.length !== features.length) {
        window.stormTrackData.testAlertFeatures = remaining;
        _replot();
    }
}

function _start_expiry_check() {
    if (_expiryInterval) return;
    _expiryInterval = setInterval(_check_expiry, 15000);
}

function _stop_expiry_check() {
    if (_expiryInterval) {
        clearInterval(_expiryInterval);
        _expiryInterval = null;
    }
}

function _on_message(event) {
    if (!event.data) return;
    var msg = event.data;

    if (msg.type === 'test-alerts-update') {
        if (!_enabled) return;
        window.stormTrackData.testAlertFeatures = msg.features || [];
        _replot();
        var hasBlinking = (msg.features || []).some(function(f) { return f.properties && f.properties.blinking; });
        if (hasBlinking) _schedule_blink_stop();
    }

    if (msg.type === 'test-alerts-clear') {
        window.stormTrackData.testAlertFeatures = [];
        if (_blinkTimer) { clearTimeout(_blinkTimer); _blinkTimer = null; }
        _replot();
    }
}

function _init_channel() {
    if (_channel) return;
    _channel = new BroadcastChannel('stormtrack-test-alerts');
    _channel.onmessage = _on_message;
}

function enable() {
    _enabled = true;
    _init_channel();
    _start_expiry_check();
}

function disable() {
    _enabled = false;
    window.stormTrackData.testAlertFeatures = [];
    if (_blinkTimer) { clearTimeout(_blinkTimer); _blinkTimer = null; }
    _stop_expiry_check();
    _replot();
}

_init_channel();

armFunctions.toggleswitchFunctions($('#devTestAlertsSwitchElem'), function() {
    enable();
}, function() {
    disable();
});

$('#devOpenAlertEditorBtn').on('click', function() {
    if (window.stormTrackProDesktop && window.stormTrackProDesktop.openAlertEditor) {
        window.stormTrackProDesktop.openAlertEditor();
    }
});

$('#devTestAlertBannerBtn').on('click', function() {
    var alerts_display_state = require('../alerts/alerts_display_state');
    var filter_alerts = require('../alerts/filter_alerts');
    var is_severe = filter_alerts.is_severe_or_statement || (function() { return false; });
    var alertsData = window.stormTrackData && window.stormTrackData.alerts_data;
    if (!alertsData || !alertsData.features || !alertsData.features.length) {
        var notif = require('../core/notifications/notification_bubble');
        notif.notify('No active alerts to test with', { icon: 'fa fa-circle-xmark', level: 'warning' });
        return;
    }
    var eligible = alertsData.features.filter(function(f) {
        var event = f.properties && f.properties.event;
        if (!event) return false;
        if (!alerts_display_state.get_alert_type_enabled(event)) return false;
        return is_severe(event);
    });
    if (!eligible.length) {
        eligible = alertsData.features.filter(function(f) {
            var event = f.properties && f.properties.event;
            return event && alerts_display_state.get_alert_type_enabled(event);
        });
    }
    if (!eligible.length) {
        var notif = require('../core/notifications/notification_bubble');
        notif.notify('No enabled alerts to test with', { icon: 'fa fa-circle-xmark', level: 'warning' });
        return;
    }
    var pick = eligible[Math.floor(Math.random() * eligible.length)];
    window.dispatchEvent(new CustomEvent('headerAlertBanner', {
        detail: { features: [pick], _devtest: true }
    }));
});

module.exports = {
    enable,
    disable,
    is_enabled: _is_enabled
};
