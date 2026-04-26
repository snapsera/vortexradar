const RadarLoopController = require('./RadarLoopController');
const radar_scan_animation = require('../station_markers/radar_scan_animation');
const settings_store = require('../../core/menu/settings_store');
const { get_station_timezone } = require('../libnexrad/nexrad_locations');
const PRELOAD_UI_RENDER_MIN_MS = 100;
const IDLE_UI_RENDER_MIN_MS = 16;

function _format_frame_time(dateValue, includeTz) {
    if (!dateValue) return '--:--';
    const js_date = dateValue instanceof Date ? dateValue : new Date(dateValue);
    if (Number.isNaN(js_date.getTime())) return '--:--';
    const station = window.stormTrackData?.currentStation;
    const tz = station ? get_station_timezone(station) : undefined;
    const opts = { hour: 'numeric', minute: '2-digit' };
    if (includeTz) opts.timeZoneName = 'short';
    if (tz) opts.timeZone = tz;
    return js_date.toLocaleTimeString([], opts);
}

function _render_status(state) {
    const status_elem = $('#radarLoopStatus');
    const idle_meta_elem = $('#radarLoopIdleMeta');
    const frames = state.frames || [];
    if (!state.active || !state.supported) {
        status_elem.text('--/--');
        idle_meta_elem.text('Scan: --:--:--');
        return;
    }
    if (!frames.length) {
        status_elem.text('--/--');
        idle_meta_elem.text('Scan: --:--:--');
        return;
    }
    if (state.preloading && state.preloadTotal > 0) {
        const pct = Math.min(100, Math.round((state.preloadLoaded / state.preloadTotal) * 100));
        status_elem.text(`Loading ${pct}%`);
        idle_meta_elem.text(`Loading ${pct}%`);
        return;
    }
    const frame_num = (state.currentFrameIndex || 0) + 1;
    const current_date = state.currentFrameDate || frames[state.currentFrameIndex]?.date;
    const formatted_time = _format_frame_time(current_date, true);
    status_elem.text(`${frame_num}/${frames.length} ${formatted_time}`);
    idle_meta_elem.text(`Scan: ${_format_frame_time(current_date, false)}`);
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
var _pendingStateForRender = null;
var _renderControlsTimer = null;
var _lastRenderControlsMs = 0;
var _playbackSessionActive = false;

function _close_quick_menus() {
    $('#radarLoopSpeedMenu, #radarLoopFrameCountMenu').hide();
    $('#radarLoopSpeedBtn, #radarLoopFrameCountBtn').attr('aria-expanded', 'false');
}

function _toggle_quick_menu(menuId, buttonId) {
    const menu = $(menuId);
    const btn = $(buttonId);
    const isOpen = menu.is(':visible');
    _close_quick_menus();
    if (!isOpen) {
        menu.show();
        btn.attr('aria-expanded', 'true');
    }
}

function _render_controls(state) {
    const is_supported = !!(state.active && state.supported);
    const has_frames = !!(state.frames && state.frames.length);
    const is_loop_visible = is_supported;
    const is_preloading = !!state.preloading;
    const is_playing_or_preloading = !!(state.playing || is_preloading);
    const is_preview_mode = !!(window?.stormTrackData?.radarPreviewMode);
    const station = window?.stormTrackData?.currentStation;
    const keepSweepVisibleForLiveMode = !!(window?.stormTrackData?.liveModeActive && station);
    const can_use_playback = is_supported && has_frames;

    if (state.playing || is_preloading) {
        _playbackSessionActive = true;
    }
    if (!can_use_playback) {
        _playbackSessionActive = false;
    }

    if (!is_preview_mode && is_playing_or_preloading && !_sweepHiddenForPlayback && !keepSweepVisibleForLiveMode) {
        _sweepHiddenForPlayback = true;
        radar_scan_animation.remove();
    } else if ((!is_playing_or_preloading || is_preview_mode || keepSweepVisibleForLiveMode) && _sweepHiddenForPlayback) {
        _sweepHiddenForPlayback = false;
        var sweepEnabled = settings_store.load().radarSweep;
        if ((keepSweepVisibleForLiveMode || sweepEnabled !== false) && station) {
            radar_scan_animation.update(station);
        }
    } else if (keepSweepVisibleForLiveMode && station && !radar_scan_animation.is_active()) {
        radar_scan_animation.update(station);
    }

    $('#radarLoopPanel').toggleClass('radarLoopPanel-disabled', !can_use_playback);
    $('#radarLoopIdleUI').toggle(!_playbackSessionActive);
    $('#radarLoopPlaybackUI').toggle(_playbackSessionActive);

    $('#radarLoopPlayStartBtn').prop('disabled', !can_use_playback || is_preloading);
    $('#radarLoopSpeedSelect').val(String(state.speedMultiplier || 5));
    $('#radarLoopFrameCountSelect').val(String(state.frameCount || 14));
    $('#radarLoopSpeedValue').text(`${state.speedMultiplier || 5}x`);
    $('#radarLoopFrameCountValue').text(`${state.frameCount || 14}`);
    $('#radarLoopSpeedBtn').attr('title', 'Playback Speed');
    $('#radarLoopFrameCountBtn').attr('title', `Load previous ${state.frameCount || 14} frames`);
    $('#radarLoopSpeedBtn, #radarLoopFrameCountBtn').prop('disabled', !is_supported || is_preloading);
    if (!is_supported || is_preloading) {
        _close_quick_menus();
    }

    if (is_preloading) {
        $('#radarLoopPauseBtn').html('<i class="fa-solid fa-spinner"></i>');
        $('#radarLoopPauseBtn').prop('disabled', true);
        $('#radarLoopPauseBtn').toggleClass('radarLoopBtn-playing', true);
    } else {
        $('#radarLoopPauseBtn').html(state.playing ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>');
        $('#radarLoopPauseBtn').prop('disabled', !can_use_playback);
        $('#radarLoopPauseBtn').toggleClass('radarLoopBtn-playing', !!state.playing);
    }
    $('#radarLoopStopBtn').prop('disabled', !_playbackSessionActive);

    const max_idx = Math.max((state.frames || []).length - 1, 0);
    const current_idx = Math.max(0, Math.min(max_idx, state.currentFrameIndex || 0));
    $('#radarLoopFrameSlider')
        .attr('max', String(max_idx))
        .val(String(current_idx))
        .prop('disabled', !can_use_playback || is_preloading);
    const frames = state.frames || [];
    const first_time = frames.length ? _format_frame_time(frames[0]?.date, false) : '--:--';
    const current_time = frames.length ? _format_frame_time(state.currentFrameDate || frames[current_idx]?.date, false) : '--:--';
    const last_time = frames.length ? _format_frame_time(frames[frames.length - 1]?.date, false) : '--:--';
    $('#radarLoopTimelineStart').text(first_time);
    $('#radarLoopTimelineCurrent').text(current_time);
    $('#radarLoopTimelineEnd').text(last_time);

    if (is_loop_visible) {
        $('#radarDateTime').hide();
    } else {
        $('#radarDateTime').show();
    }
    _render_preload_bar(state);
    _render_status(state);
    if (window?.stormTrackData) {
        const perf = window.stormTrackData.perf = window.stormTrackData.perf || {};
        perf.radarLoopUiRenders = (perf.radarLoopUiRenders || 0) + 1;
        perf.radarLoopUiPreloading = !!state.preloading;
        perf.radarLoopSessionActive = !!_playbackSessionActive;
    }
}

function _schedule_render_controls(state) {
    _pendingStateForRender = state || {};
    const minInterval = _pendingStateForRender.preloading ? PRELOAD_UI_RENDER_MIN_MS : IDLE_UI_RENDER_MIN_MS;
    const elapsed = performance.now() - _lastRenderControlsMs;
    if (_renderControlsTimer) return;

    const run = () => {
        _renderControlsTimer = null;
        _lastRenderControlsMs = performance.now();
        _render_controls(_pendingStateForRender || {});
    };

    if (elapsed >= minInterval) {
        requestAnimationFrame(run);
        return;
    }

    _renderControlsTimer = setTimeout(() => {
        requestAnimationFrame(run);
    }, Math.max(0, minInterval - elapsed));
}

function init() {
    const controller = new RadarLoopController();
    window.stormTrackData.radarLoopController = controller;

    var _savedLoop = settings_store.load();
    if (_savedLoop.radarLoopSpeed) controller.state.speedMultiplier = _savedLoop.radarLoopSpeed;
    if (_savedLoop.radarLoopFrameCount) controller.state.frameCount = _savedLoop.radarLoopFrameCount;

    window.addEventListener('radarBaseFactoryLoaded', (event) => {
        const detail = event.detail || {};
        controller.on_base_radar_changed(detail.station, detail.product, detail.factory, {
            isStormRelative: !!detail.isStormRelative
        });
    });
    window.addEventListener('radarBaseSelectionRequested', () => {
        controller._resume_after_switch = controller.state.playing || controller.state.preloading;
        controller._cancel_preload();
        controller.pause();
    });

    window.addEventListener('radarLoopStateChanged', (event) => {
        _schedule_render_controls(event.detail || {});
    });

    $('#radarLoopPlayStartBtn').on('click', () => {
        _playbackSessionActive = true;
        controller.play();
    });
    $('#radarLoopPauseBtn').on('click', () => controller.toggle_play());
    $('#radarLoopStopBtn').on('click', () => {
        _playbackSessionActive = false;
        _close_quick_menus();
        controller.stop_and_reset_to_latest();
    });
    $('#radarLoopFrameSlider').on('input change', function() {
        controller.set_frame_index($(this).val());
    });
    $('#radarLoopSpeedBtn').on('click', function(e) {
        e.stopPropagation();
        if ($(this).prop('disabled')) return;
        _toggle_quick_menu('#radarLoopSpeedMenu', '#radarLoopSpeedBtn');
    });
    $('#radarLoopFrameCountBtn').on('click', function(e) {
        e.stopPropagation();
        if ($(this).prop('disabled')) return;
        _toggle_quick_menu('#radarLoopFrameCountMenu', '#radarLoopFrameCountBtn');
    });
    $('#radarLoopSpeedMenu').on('click', '.radarLoopQuickMenuItem', function(e) {
        e.stopPropagation();
        const speed = $(this).data('speed');
        controller.set_speed(speed);
        $('#radarLoopSpeedSelect').val(String(speed));
        const saved = settings_store.load();
        saved.radarLoopSpeed = parseFloat(speed) || saved.radarLoopSpeed;
        settings_store.save(saved);
        _close_quick_menus();
    });
    $('#radarLoopFrameCountMenu').on('click', '.radarLoopQuickMenuItem', function(e) {
        e.stopPropagation();
        const frameCount = $(this).data('frame-count');
        controller.set_frame_count(frameCount);
        $('#radarLoopFrameCountSelect').val(String(frameCount));
        const saved = settings_store.load();
        saved.radarLoopFrameCount = parseInt(frameCount, 10) || saved.radarLoopFrameCount;
        settings_store.save(saved);
        _close_quick_menus();
    });
    $(document.body).on('click.radarLoopQuickMenus', function(e) {
        const isQuickMenuTarget = $(e.target).closest('#radarLoopSpeedBtn, #radarLoopFrameCountBtn, #radarLoopSpeedMenu, #radarLoopFrameCountMenu').length > 0;
        if (!isQuickMenuTarget) _close_quick_menus();
    });

    window.addEventListener('radarScanUpdated', () => {
        if (window?.stormTrackData?.appPausedForPromo) return;
        if (window?.stormTrackData?.liveModeActive) return;
        if (!window?.stormTrackData?.loopPlayback?.active || !window?.stormTrackData?.loopPlayback?.supported) return;
        if (window?.stormTrackData?.loopPlayback?.playing) return;
        controller.refresh_frames();
    });

    setInterval(() => {
        if (window?.stormTrackData?.appPausedForPromo) return;
        if (window?.stormTrackData?.liveModeActive) return;
        if (!window?.stormTrackData?.loopPlayback?.active || !window?.stormTrackData?.loopPlayback?.supported) return;
        controller.refresh_frames();
    }, 45000);

    const current_factory = window?.stormTrackData?.nexrad_factory;
    if (current_factory?.station && current_factory?.product_abbv) {
        controller.on_base_radar_changed(current_factory.station, current_factory.product_abbv, current_factory);
    }

    _schedule_render_controls(window.stormTrackData.loopPlayback || {});
}

module.exports = { init };
