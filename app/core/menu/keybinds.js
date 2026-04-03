const settings_store = require('./settings_store');
const display_app_dialog = require('./app_dialog');

const KEYBIND_DEFAULTS = {
    playbackToggle: 'Space',
    playbackBack: 'ArrowLeft',
    playbackForward: 'ArrowRight',
    productReflectivity: 'Shift+R',
    productBaseVelocity: 'Shift+V',
    productStormRelativeVelocity: 'Shift+S',
    productCorrelationCoefficient: 'Shift+C'
};

const KEYBIND_ACTIONS = [
    { id: 'playbackToggle', buttonId: '#keybindPlaybackToggleBtn' },
    { id: 'playbackBack', buttonId: '#keybindPlaybackBackBtn' },
    { id: 'playbackForward', buttonId: '#keybindPlaybackForwardBtn' },
    { id: 'productReflectivity', buttonId: '#keybindProductReflectivityBtn' },
    { id: 'productBaseVelocity', buttonId: '#keybindProductBaseVelocityBtn' },
    { id: 'productStormRelativeVelocity', buttonId: '#keybindProductStormRelativeVelocityBtn' },
    { id: 'productCorrelationCoefficient', buttonId: '#keybindProductCorrelationCoefficientBtn' }
];

let _currentKeybinds = Object.assign({}, KEYBIND_DEFAULTS);
let _captureAction = null;

function _should_ignore_shortcut(event) {
    const target = event.target;
    if (!target) return false;
    const tag = (target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') return true;
    if (target.isContentEditable) return true;
    return false;
}

function _format_key_token(key) {
    if (!key) return null;
    if (key === ' ') return 'Space';
    if (key === 'Spacebar') return 'Space';
    if (key === 'Left') return 'ArrowLeft';
    if (key === 'Right') return 'ArrowRight';
    if (key === 'Up') return 'ArrowUp';
    if (key === 'Down') return 'ArrowDown';
    if (key.length === 1) return key.toUpperCase();
    return key;
}

function _event_to_combo(event) {
    const keyToken = _format_key_token(event.key);
    if (!keyToken) return null;
    if (keyToken === 'Shift' || keyToken === 'Control' || keyToken === 'Alt' || keyToken === 'Meta') {
        return null;
    }

    const parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.metaKey) parts.push('Meta');
    if (event.shiftKey && keyToken !== 'Shift') parts.push('Shift');
    parts.push(keyToken);
    return parts.join('+');
}

function _normalize_saved_keybinds(saved) {
    const merged = Object.assign({}, KEYBIND_DEFAULTS);
    if (!saved || typeof saved !== 'object') return merged;
    Object.keys(KEYBIND_DEFAULTS).forEach((key) => {
        const value = saved[key];
        if (typeof value === 'string' && value.trim()) {
            merged[key] = value.trim();
        }
    });
    return merged;
}

function _refresh_keybinds_from_settings() {
    const settings = settings_store.load();
    _currentKeybinds = _normalize_saved_keybinds(settings.keybinds);
}

function _save_keybinds(nextKeybinds) {
    const settings = settings_store.load();
    settings.keybinds = _normalize_saved_keybinds(nextKeybinds);
    settings_store.save(settings);
    _refresh_keybinds_from_settings();
}

function _render_keybind_buttons() {
    KEYBIND_ACTIONS.forEach((action) => {
        const keybind = _currentKeybinds[action.id] || KEYBIND_DEFAULTS[action.id];
        $(action.buttonId).text(keybind);
    });
}

function _set_capture_hint(text, isError = false) {
    const $hint = $('#keybindCaptureHint');
    if (!$hint.length) return;
    $hint.text(text || '');
    $hint.toggleClass('keybindCaptureHint-error', !!isError);
    $hint.css('color', isError ? '#ff9d9d' : '#9ec0dd');
}

function _set_button_visual_state($button, listening) {
    if (!$button || !$button.length) return;
    if (listening) {
        $button.css({
            'border-color': 'rgba(255, 212, 103, 0.95)',
            'background': 'rgba(255, 212, 103, 0.18)',
            'color': '#ffe8a6'
        });
        return;
    }
    $button.css({
        'border-color': 'rgba(143,208,255,.35)',
        'background': 'rgba(255,255,255,.05)',
        'color': '#d8ecff'
    });
}

function _suppress_event(event) {
    if (!event) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    const nativeEvent = event.originalEvent || event;
    if (nativeEvent && typeof nativeEvent.stopImmediatePropagation === 'function') {
        nativeEvent.stopImmediatePropagation();
    }
}

function _stop_capture() {
    _captureAction = null;
    $('.keybindCaptureBtn').removeClass('keybindCaptureBtn-listening').each(function() {
        _set_button_visual_state($(this), false);
    });
}

function _start_capture(actionId, buttonSelector) {
    _captureAction = actionId;
    $('.keybindCaptureBtn').removeClass('keybindCaptureBtn-listening').each(function() {
        _set_button_visual_state($(this), false);
    });
    const $button = $(buttonSelector);
    $button.addClass('keybindCaptureBtn-listening');
    _set_button_visual_state($button, true);
    _set_capture_hint('Press a key combination. Press Escape to cancel.');
}

function _trigger_product(value) {
    const $row = $(`.psmRow[value="${value}"]`).first();
    if (!$row.length) return;
    $row.trigger('click');
}

function _playback_supported() {
    const loop = window?.stormTrackData?.loopPlayback;
    return !!(loop?.active && loop?.supported);
}

function _execute_playback_toggle() {
    const controller = window?.stormTrackData?.radarLoopController;
    const loop = window?.stormTrackData?.loopPlayback;
    if (!controller || !loop) return;
    if (loop.preloading) {
        controller.toggle_play_stop();
        return;
    }
    controller.toggle_play();
}

function _execute_playback_step(stepDelta) {
    const controller = window?.stormTrackData?.radarLoopController;
    const loop = window?.stormTrackData?.loopPlayback;
    if (!controller || !loop || !Array.isArray(loop.frames) || !loop.frames.length) return;
    const maxIndex = loop.frames.length - 1;
    const currentIndex = Number.isFinite(loop.currentFrameIndex) ? loop.currentFrameIndex : 0;
    const nextIndex = currentIndex + stepDelta;
    if (nextIndex < 0 || nextIndex > maxIndex) return;
    controller.set_frame_index(nextIndex);
}

function _handle_action(actionId) {
    switch (actionId) {
    case 'playbackToggle':
        if (!_playback_supported()) return false;
        _execute_playback_toggle();
        return true;
    case 'playbackBack':
        if (!_playback_supported()) return false;
        _execute_playback_step(-1);
        return true;
    case 'playbackForward':
        if (!_playback_supported()) return false;
        _execute_playback_step(1);
        return true;
    case 'productReflectivity':
        _trigger_product('ref');
        return true;
    case 'productBaseVelocity':
        _trigger_product('vel');
        return true;
    case 'productStormRelativeVelocity':
        _trigger_product('srvel');
        return true;
    case 'productCorrelationCoefficient':
        _trigger_product('rho');
        return true;
    default:
        return false;
    }
}

function _handle_capture_keydown(event) {
    if (!_captureAction) return false;

    const combo = _event_to_combo(event);
    _suppress_event(event);

    if (!combo) return true;
    if (combo === 'Escape') {
        _stop_capture();
        _set_capture_hint('Capture cancelled.');
        return true;
    }

    const next = Object.assign({}, _currentKeybinds, { [_captureAction]: combo });
    _save_keybinds(next);
    _render_keybind_buttons();
    _stop_capture();
    _set_capture_hint(`Saved: ${combo}`);
    return true;
}

function _handle_global_keydown(event) {
    if (_handle_capture_keydown(event)) return;
    if (_should_ignore_shortcut(event)) return;

    const combo = _event_to_combo(event);
    if (!combo) return;

    const actionId = Object.keys(_currentKeybinds).find((key) => _currentKeybinds[key] === combo);
    if (!actionId) return;

    const handled = _handle_action(actionId);
    if (handled) {
        _suppress_event(event);
    }
}

function _bind_keybind_settings_ui() {
    KEYBIND_ACTIONS.forEach((action) => {
        $(document).on('click', action.buttonId, function() {
            _start_capture(action.id, action.buttonId);
        });
    });

    $(document).on('click', '#keybindsResetDefaultsBtn', function() {
        _save_keybinds(KEYBIND_DEFAULTS);
        _render_keybind_buttons();
        _stop_capture();
        _set_capture_hint('Keybinds reset to defaults.');
    });
}

function _render_keybinds_dialog_body() {
    return `
        <div style="display:flex;flex-direction:column;gap:10px;">
            <div style="font-size:11px;font-weight:800;letter-spacing:.08em;color:#95adbf;">PLAYBACK SHORTCUTS</div>
            <div class="menu-row armrTop keybindRow" style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
                Play / Pause
                <button type="button" id="keybindPlaybackToggleBtn" class="keybindCaptureBtn" style="background:rgba(255,255,255,.05);border:1px solid rgba(143,208,255,.35);color:#d8ecff;border-radius:8px;font-size:12px;font-weight:700;min-width:120px;padding:6px 10px;text-align:center;">${_currentKeybinds.playbackToggle}</button>
            </div>
            <div class="menu-row armrMiddle keybindRow" style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
                Previous Frame
                <button type="button" id="keybindPlaybackBackBtn" class="keybindCaptureBtn" style="background:rgba(255,255,255,.05);border:1px solid rgba(143,208,255,.35);color:#d8ecff;border-radius:8px;font-size:12px;font-weight:700;min-width:120px;padding:6px 10px;text-align:center;">${_currentKeybinds.playbackBack}</button>
            </div>
            <div class="menu-row armrBottom keybindRow" style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
                Next Frame
                <button type="button" id="keybindPlaybackForwardBtn" class="keybindCaptureBtn" style="background:rgba(255,255,255,.05);border:1px solid rgba(143,208,255,.35);color:#d8ecff;border-radius:8px;font-size:12px;font-weight:700;min-width:120px;padding:6px 10px;text-align:center;">${_currentKeybinds.playbackForward}</button>
            </div>

            <div style="font-size:11px;font-weight:800;letter-spacing:.08em;color:#95adbf;margin-top:6px;">PRODUCT SHORTCUTS (ALWAYS ON)</div>
            <div class="menu-row armrTop keybindRow" style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
                Reflectivity
                <button type="button" id="keybindProductReflectivityBtn" class="keybindCaptureBtn" style="background:rgba(255,255,255,.05);border:1px solid rgba(143,208,255,.35);color:#d8ecff;border-radius:8px;font-size:12px;font-weight:700;min-width:120px;padding:6px 10px;text-align:center;">${_currentKeybinds.productReflectivity}</button>
            </div>
            <div class="menu-row armrMiddle keybindRow" style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
                Base Velocity
                <button type="button" id="keybindProductBaseVelocityBtn" class="keybindCaptureBtn" style="background:rgba(255,255,255,.05);border:1px solid rgba(143,208,255,.35);color:#d8ecff;border-radius:8px;font-size:12px;font-weight:700;min-width:120px;padding:6px 10px;text-align:center;">${_currentKeybinds.productBaseVelocity}</button>
            </div>
            <div class="menu-row armrMiddle keybindRow" style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
                Storm Relative Velocity
                <button type="button" id="keybindProductStormRelativeVelocityBtn" class="keybindCaptureBtn" style="background:rgba(255,255,255,.05);border:1px solid rgba(143,208,255,.35);color:#d8ecff;border-radius:8px;font-size:12px;font-weight:700;min-width:120px;padding:6px 10px;text-align:center;">${_currentKeybinds.productStormRelativeVelocity}</button>
            </div>
            <div class="menu-row armrBottom keybindRow" style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
                CC Drops
                <button type="button" id="keybindProductCorrelationCoefficientBtn" class="keybindCaptureBtn" style="background:rgba(255,255,255,.05);border:1px solid rgba(143,208,255,.35);color:#d8ecff;border-radius:8px;font-size:12px;font-weight:700;min-width:120px;padding:6px 10px;text-align:center;">${_currentKeybinds.productCorrelationCoefficient}</button>
            </div>

            <div id="keybindCaptureHint" class="keybindCaptureHint" style="margin:10px 6px 8px;color:#9ec0dd;font-size:12px;line-height:1.35;">Click a shortcut to rebind it.</div>
            <div class="menu-row devtools-action-row" id="keybindsResetDefaultsBtn">
                <i class="armrIcon armrIcon-Blue fa-solid fa-rotate"></i>
                Reset to Defaults
            </div>
        </div>
    `;
}

function _open_keybinds_dialog() {
    _refresh_keybinds_from_settings();
    _stop_capture();
    display_app_dialog({
        title: 'Keyboard Shortcuts',
        subtitle: 'Customizable controls',
        body: _render_keybinds_dialog_body(),
        color: '#1b2637',
        textColor: '#d8ecff',
        noBackdropBlur: true,
        draggable: true,
        allowBackgroundInteraction: true
    });
}

function init() {
    _refresh_keybinds_from_settings();
    _bind_keybind_settings_ui();

    document.addEventListener('keydown', _handle_global_keydown, true);
    $(document).on('click', '#armrKeybindsBtn', function() {
        _open_keybinds_dialog();
    });
}

module.exports = {
    init
};
