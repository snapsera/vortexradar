var _queue = [];
var _showing = false;
var _hideTimer = null;
var DISPLAY_MS = 15000;
var TRANSITION_MS = 560;

function _get_top_offset() {
    var headerH = $('#radarHeader').outerHeight() || 0;
    var colorScale = document.getElementById('mapColorScale');
    var colorScaleH = (colorScale && colorScale.style.display !== 'none') ? (colorScale.offsetHeight || 0) : 0;
    var preloadBar = document.getElementById('playbackPreloadBar');
    var preloadH = (preloadBar && preloadBar.style.display !== 'none') ? (preloadBar.offsetHeight || 0) : 0;
    return headerH + colorScaleH + preloadH + 6;
}

function _dismiss() {
    var bubble = document.getElementById('notificationBubble');
    if (!bubble) return;
    if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
    bubble.classList.add('notificationBubble-fading');
    setTimeout(function() {
        bubble.classList.remove('notificationBubble-visible');
        bubble.classList.remove('notificationBubble-fading');
    }, 500);
    setTimeout(_show_next, TRANSITION_MS);
}

function _show_next() {
    if (_queue.length === 0) {
        _showing = false;
        return;
    }

    _showing = true;
    var item = _queue.shift();

    var bubble = document.getElementById('notificationBubble');
    var iconEl = document.getElementById('notificationBubbleIcon');
    var textEl = document.getElementById('notificationBubbleText');
    if (!bubble || !iconEl || !textEl) return;

    bubble.className = 'notificationBubble';
    if (item.level) {
        bubble.classList.add('notificationBubble-' + item.level);
    }

    iconEl.className = 'notificationBubbleIcon';
    if (item.icon) {
        iconEl.className = 'notificationBubbleIcon ' + item.icon;
    }

    textEl.textContent = item.text || '';
    bubble.style.top = _get_top_offset() + 'px';
    bubble.classList.remove('notificationBubble-fading');
    bubble.classList.add('notificationBubble-visible');

    if (_hideTimer) clearTimeout(_hideTimer);
    _hideTimer = setTimeout(function() {
        bubble.classList.add('notificationBubble-fading');
        setTimeout(function() {
            bubble.classList.remove('notificationBubble-visible');
            bubble.classList.remove('notificationBubble-fading');
        }, 500);
        setTimeout(_show_next, TRANSITION_MS);
    }, DISPLAY_MS);
}

function notify(text, options) {
    options = options || {};
    _queue.push({
        text: text,
        icon: options.icon || 'fa fa-circle-info',
        level: options.level || 'info'
    });
    if (!_showing) {
        _show_next();
    }
}

function _get_alert_severity_level(event) {
    var e = (event || '').toLowerCase();
    if (e.indexOf('tornado') !== -1) return 'danger';
    if (e.indexOf('severe thunderstorm') !== -1) return 'danger';
    if (e.indexOf('flash flood') !== -1) return 'warning';
    if (e.indexOf('warning') !== -1) return 'warning';
    if (e.indexOf('watch') !== -1) return 'info';
    return 'info';
}

function _pluralize_event(event) {
    if (event.endsWith('y')) return event.slice(0, -1) + 'ies';
    if (event.endsWith('ch') || event.endsWith('sh') || event.endsWith('ss') || event.endsWith('x')) return event + 'es';
    return event + 's';
}

function _get_alert_icon(event) {
    var e = (event || '').toLowerCase();
    if (e.indexOf('tornado') !== -1) return 'fa fa-tornado';
    if (e.indexOf('thunderstorm') !== -1) return 'fa fa-bolt';
    if (e.indexOf('flood') !== -1) return 'fa fa-water';
    if (e.indexOf('winter') !== -1 || e.indexOf('ice') !== -1 || e.indexOf('blizzard') !== -1) return 'fa fa-snowflake';
    if (e.indexOf('wind') !== -1) return 'fa fa-wind';
    if (e.indexOf('fire') !== -1) return 'fa fa-fire';
    if (e.indexOf('hurricane') !== -1 || e.indexOf('tropical') !== -1) return 'fa fa-hurricane';
    return 'fa fa-triangle-exclamation';
}

function init() {
    var bubble = document.getElementById('notificationBubble');
    if (bubble) {
        bubble.addEventListener('click', _dismiss);
    }

    window.addEventListener('radarScanUpdated', function() {
        var station = window.stormTrackData?.currentStation || '';
        notify('New radar scan available' + (station ? ' for ' + station : ''), {
            icon: 'fa fa-satellite-dish',
            level: 'success'
        });
    });

    /* DISABLED — alert notifications temporarily disabled; only radar scan kept active
    window.addEventListener('alertNotification', function(e) {
        var detail = e.detail || {};
        var eventName = detail.event || 'Weather Alert';

        var alerts_display_state = require('../../alerts/alerts_display_state');
        if (alerts_display_state.is_granular_event(eventName) &&
            !alerts_display_state.get_alert_type_enabled(eventName)) {
            return;
        }

        var type = detail.type || 'new';
        var count = detail.count || 1;

        var prefix = '';
        if (type === 'new') prefix = 'NEW: ';
        else if (type === 'updated') prefix = 'UPDATED: ';

        var extra = detail.extra || '';
        var text;
        if (type === 'new' && count > 1) {
            text = 'NEW: ' + count + ' ' + _pluralize_event(eventName);
        } else {
            text = prefix + eventName + (extra ? ' — ' + extra : '');
        }

        notify(text, {
            icon: _get_alert_icon(eventName),
            level: _get_alert_severity_level(eventName)
        });
    });
    */
}

module.exports = { init, notify };
