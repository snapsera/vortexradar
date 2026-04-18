var _toast = null;
var _hideTimer = null;
var _unsubscribe = null;

function _is_desktop_app() {
    try {
        return new URLSearchParams(window.location.search || '').get('desktopApp') === '1';
    } catch (_) {
        return false;
    }
}

function _render_toast() {
    if (_toast && _toast.length) return _toast;
    $('body').append('<div id="desktopUpdateToast" class="desktopUpdateToast" aria-live="polite"></div>');
    _toast = $('#desktopUpdateToast');
    return _toast;
}

function _clear_hide_timer() {
    if (_hideTimer) {
        clearTimeout(_hideTimer);
        _hideTimer = null;
    }
}

function _show(message, opts) {
    var options = opts || {};
    var typeClass = options.typeClass || '';
    var autoHideMs = options.autoHideMs || 0;
    var $toast = _render_toast();
    _clear_hide_timer();
    $toast.removeClass('desktopUpdateToast--ok desktopUpdateToast--warn desktopUpdateToast--error');
    if (typeClass) $toast.addClass(typeClass);
    $toast.text(message || '').addClass('desktopUpdateToast--visible');
    if (autoHideMs > 0) {
        _hideTimer = setTimeout(function() {
            $toast.removeClass('desktopUpdateToast--visible');
        }, autoHideMs);
    }
}

function _handle_status(payload) {
    var state = payload && payload.state;
    if (state === 'checking') {
        _show('Checking for updates...');
        return;
    }
    if (state === 'available') {
        _show('Update found. Downloading...', { typeClass: 'desktopUpdateToast--warn' });
        return;
    }
    if (state === 'downloading') {
        var percent = Number(payload.percent || 0);
        _show('Downloading update... ' + Math.max(0, Math.min(100, Math.round(percent))) + '%', {
            typeClass: 'desktopUpdateToast--warn',
        });
        return;
    }
    if (state === 'downloaded') {
        _show('Update ready. Restart to install.', {
            typeClass: 'desktopUpdateToast--ok',
            autoHideMs: 4500,
        });
        return;
    }
    if (state === 'installing') {
        var installPercent = Number(payload.percent || 0);
        _show('Installing update... ' + Math.max(0, Math.min(95, Math.round(installPercent))) + '%', {
            typeClass: 'desktopUpdateToast--warn',
        });
        return;
    }
    if (state === 'installing-handoff') {
        _show('Finalizing update and restarting...', {
            typeClass: 'desktopUpdateToast--warn',
        });
        return;
    }
    if (state === 'up-to-date') {
        _show('App is up to date.', {
            typeClass: 'desktopUpdateToast--ok',
            autoHideMs: 2600,
        });
        return;
    }
    if (state === 'error') {
        _show('Update check failed. Retrying on next launch.', {
            typeClass: 'desktopUpdateToast--error',
            autoHideMs: 4500,
        });
    }
}

function init() {
    if (!_is_desktop_app()) return;
    if (!window.desktopUpdater || typeof window.desktopUpdater.onStatus !== 'function') return;
    _unsubscribe = window.desktopUpdater.onStatus(_handle_status);
    window.addEventListener('beforeunload', function() {
        if (typeof _unsubscribe === 'function') _unsubscribe();
    }, { once: true });
}

module.exports = { init: init };
