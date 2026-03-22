const RadarLoopController = require('./RadarLoopController');
const radar_scan_animation = require('../station_markers/radar_scan_animation');
const settings_store = require('../../core/menu/settings_store');
const { get_station_timezone } = require('../libnexrad/nexrad_locations');

function _should_ignore_shortcut(event) {
    const target = event.target;
    if (!target) return false;
    const tag = (target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') return true;
    if (target.isContentEditable) return true;
    return false;
}

function _render_status(state) {
    const status_elem = $('#radarLoopStatus');
    const frames = state.frames || [];
    if (!state.active || !state.supported) {
        status_elem.text('--/--');
        return;
    }
    if (!frames.length) {
        status_elem.text('--/--');
        return;
    }
    if (state.preloading && state.preloadTotal > 0) {
        const pct = Math.min(100, Math.round((state.preloadLoaded / state.preloadTotal) * 100));
        status_elem.text(`Loading ${pct}%`);
        return;
    }
    const frame_num = (state.currentFrameIndex || 0) + 1;
    const current_date = state.currentFrameDate || frames[state.currentFrameIndex]?.date;
    let formatted_time = '--:--';
    if (current_date) {
        const js_date = current_date instanceof Date ? current_date : new Date(current_date);
        if (!Number.isNaN(js_date.getTime())) {
            const station = window.stormTrackData?.currentStation;
            const tz = station ? get_station_timezone(station) : undefined;
            const opts = { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
            if (tz) opts.timeZone = tz;
            formatted_time = js_date.toLocaleTimeString([], opts);
        }
    }
    status_elem.text(`${frame_num}/${frames.length} ${formatted_time}`);
}

function _position_preload_bar() {
    var bar = document.getElementById('playbackPreloadBar');
    if (!bar) return;
    var headerH = $('#radarHeader').outerHeight() || 0;
    var colorScale = document.getElementById('mapColorScale');
    var colorScaleH = (colorScale && colorScale.style.display !== 'none') ? (colorScale.offsetHeight || 0) : 0;
    bar.style.top = (headerH + colorScaleH) + 'px';
}

function _render_preload_bar(state) {
    const bar = document.getElementById('playbackPreloadBar');
    const inner = document.getElementById('playbackPreloadBarInner');
    if (!bar || !inner) return;

    if (state.preloading && state.preloadTotal > 0) {
        bar.style.display = '';
        _position_preload_bar();
        const pct = Math.min(100, Math.round((state.preloadLoaded / state.preloadTotal) * 100));
        inner.style.width = pct + '%';
    } else {
        inner.style.width = '0%';
        bar.style.display = 'none';
    }
}

var _sweepHiddenForPlayback = false;

function _render_controls(state) {
    const is_supported = !!(state.active && state.supported);
    const has_frames = !!(state.frames && state.frames.length);
    const is_loop_visible = is_supported;
    const is_preloading = !!state.preloading;
    const is_playing_or_preloading = !!(state.playing || is_preloading);

    if (is_playing_or_preloading && !_sweepHiddenForPlayback) {
        _sweepHiddenForPlayback = true;
        radar_scan_animation.remove();
    } else if (!is_playing_or_preloading && _sweepHiddenForPlayback) {
        _sweepHiddenForPlayback = false;
        var sweepEnabled = settings_store.load().radarSweep;
        var station = window.stormTrackData?.currentStation;
        if (sweepEnabled !== false && station) {
            radar_scan_animation.update(station);
        }
    }

    $('#radarLoopPanel').toggleClass('radarLoopPanel-disabled', !is_supported);
    if (is_preloading) {
        $('#radarLoopPlayBtn').html('<i class="fa fa-stop"></i>');
        $('#radarLoopPlayBtn').toggleClass('radarLoopBtn-playing', true);
    } else {
        $('#radarLoopPlayBtn').html(state.playing ? '<i class="fa fa-stop"></i>' : '<i class="fa fa-play"></i>');
        $('#radarLoopPlayBtn').toggleClass('radarLoopBtn-playing', !!state.playing);
    }
    $('#radarLoopPlayBtn, #radarLoopBackBtn, #radarLoopForwardBtn').prop('disabled', !is_supported || !has_frames);
    $('#radarLoopSpeedSelect').val(String(state.speedMultiplier || 5));
    $('#radarLoopFrameCountSelect').val(String(state.frameCount || 14));
    if (is_loop_visible) {
        $('#radarDateTime').hide();
    } else {
        $('#radarDateTime').show();
    }
    _render_preload_bar(state);
    _render_status(state);
}

function init() {
    const controller = new RadarLoopController();
    window.stormTrackData.radarLoopController = controller;

    var _savedLoop = settings_store.load();
    if (_savedLoop.radarLoopSpeed) controller.state.speedMultiplier = _savedLoop.radarLoopSpeed;
    if (_savedLoop.radarLoopFrameCount) controller.state.frameCount = _savedLoop.radarLoopFrameCount;

    window.addEventListener('radarBaseFactoryLoaded', (event) => {
        const detail = event.detail || {};
        controller.on_base_radar_changed(detail.station, detail.product, detail.factory);
    });
    window.addEventListener('radarBaseSelectionRequested', () => {
        controller._resume_after_switch = controller.state.playing || controller.state.preloading;
        controller._cancel_preload();
        controller.pause();
    });

    window.addEventListener('radarLoopStateChanged', (event) => {
        _render_controls(event.detail || {});
    });

    $('#radarLoopPlayBtn').on('click', () => controller.toggle_play_stop());
    $('#radarLoopBackBtn').on('click', () => controller.step_back());
    $('#radarLoopForwardBtn').on('click', () => controller.step_forward());
    $('#radarLoopSpeedSelect').on('change', function() {
        controller.set_speed($(this).val());
        settings_store.saveFromDom();
    });
    $('#radarLoopFrameCountSelect').on('change', function() {
        controller.set_frame_count($(this).val());
        settings_store.saveFromDom();
    });

    $(document).on('keydown', function(event) {
        if (_should_ignore_shortcut(event)) return;
        if (!window?.stormTrackData?.loopPlayback?.active || !window?.stormTrackData?.loopPlayback?.supported) return;
        if (event.code === 'Space') {
            event.preventDefault();
            controller.toggle_play_stop();
        } else if (event.code === 'ArrowLeft') {
            event.preventDefault();
            controller.step_back();
        } else if (event.code === 'ArrowRight') {
            event.preventDefault();
            controller.step_forward();
        }
    });

    window.addEventListener('radarScanUpdated', () => {
        if (!window?.stormTrackData?.loopPlayback?.active || !window?.stormTrackData?.loopPlayback?.supported) return;
        if (window?.stormTrackData?.loopPlayback?.playing) return;
        controller.refresh_frames();
    });

    setInterval(() => {
        if (!window?.stormTrackData?.loopPlayback?.active || !window?.stormTrackData?.loopPlayback?.supported) return;
        controller.refresh_frames();
    }, 45000);

    const current_factory = window?.stormTrackData?.nexrad_factory;
    if (current_factory?.station && current_factory?.product_abbv) {
        controller.on_base_radar_changed(current_factory.station, current_factory.product_abbv, current_factory);
    }

    _render_controls(window.stormTrackData.loopPlayback || {});
}

module.exports = { init };
