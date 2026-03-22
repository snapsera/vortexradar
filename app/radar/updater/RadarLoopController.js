const loaders_nexrad = require('../libnexrad/loaders_nexrad');
const { precompute_render_data } = require('../plot/calculate_coordinates');
const plot_to_map = require('../plot/plot_to_map');

const DEFAULT_SPEED_MULTIPLIER = 5;
const DEFAULT_FRAME_COUNT = 14;
const BASE_FRAME_MS = 600;
const ENDPOINT_DWELL_MS = 1100;

function _ensure_state() {
    if (!window.stormTrackData) window.stormTrackData = {};
    if (!window.stormTrackData.loopPlayback) {
        window.stormTrackData.loopPlayback = {};
    }
    const state = window.stormTrackData.loopPlayback;
    if (state.speedMultiplier == undefined) state.speedMultiplier = DEFAULT_SPEED_MULTIPLIER;
    if (state.playing == undefined) state.playing = false;
    if (state.active == undefined) state.active = false;
    if (state.supported == undefined) state.supported = false;
    if (state.frameCount == undefined) state.frameCount = DEFAULT_FRAME_COUNT;
    if (!Array.isArray(state.frames)) state.frames = [];
    if (state.currentFrameIndex == undefined) state.currentFrameIndex = 0;
    return state;
}

class RadarLoopController {
    constructor() {
        this.state = _ensure_state();
        this.frame_factory_cache = {};
        this.frame_render_cache = {};
        this.play_timer = null;
        this.fetch_controller = null;
        this.current_station = null;
        this.current_product = null;
        this.current_render_token = 0;
    }

    is_supported_loop_product(product, base_factory = null) {
        // Keep loop playback scoped to Level 3 products.
        // Level 2 uses a different data model and does not provide the same
        // time-series URL path used by this loop controller.
        if (base_factory?.nexrad_level != undefined) {
            return base_factory.nexrad_level === 3;
        }
        if (typeof product !== 'string') return false;
        if (product.startsWith('L2_')) return false;
        return true;
    }

    on_base_radar_changed(station, product, base_factory = null) {
        this._cancel_preload();
        this.state = _ensure_state();
        this.current_station = station;
        this.current_product = product;
        this.state.supported = this.is_supported_loop_product(product, base_factory);
        this.frame_factory_cache = {};
        this.frame_render_cache = {};

        if (!this.state.supported) {
            this.stop();
            this.state.active = false;
            this.state.frames = [];
            this.state.currentFrameIndex = 0;
            this._emit_state();
            return;
        }

        this.state.active = true;
        this.state.frames = [];
        this.state.currentFrameIndex = 0;
        this._emit_state();

        if (base_factory) {
            this.frame_factory_cache.__base_factory = base_factory;
        }

        this.refresh_frames(() => {
            if (this.state.frames.length === 0) return;
            this.state.currentFrameIndex = this.state.frames.length - 1;
            this.plot_frame(this.state.currentFrameIndex, { preserve_playing_state: true });
        });
    }

    refresh_frames(callback = null) {
        if (!this.state.active || !this.state.supported || !this.current_station || !this.current_product) {
            if (callback) callback();
            return;
        }

        if (this.fetch_controller) {
            this.fetch_controller.abort();
        }
        this.fetch_controller = new AbortController();
        const request_controller = this.fetch_controller;

        const was_on_latest = this.state.frames.length > 0 &&
            this.state.currentFrameIndex >= this.state.frames.length - 1;

        loaders_nexrad.get_latest_level_3_frames(
            this.current_station,
            this.current_product,
            this.state.frameCount,
            (frames) => {
                if (request_controller.signal.aborted) return;
                if (this.fetch_controller !== request_controller) return;
                this.state.frames = Array.isArray(frames) ? frames : [];
                const current_frame_date = this.state.currentFrameDate ? new Date(this.state.currentFrameDate).getTime() : null;
                if (current_frame_date) {
                    const matched_index = this.state.frames.findIndex((frame) => {
                        const frame_time = frame?.date ? new Date(frame.date).getTime() : null;
                        return frame_time === current_frame_date;
                    });
                    if (matched_index >= 0) {
                        this.state.currentFrameIndex = matched_index;
                    }
                }
                if (this.state.currentFrameIndex >= this.state.frames.length) {
                    this.state.currentFrameIndex = Math.max(this.state.frames.length - 1, 0);
                }
                if (was_on_latest && !this.state.playing && this.state.frames.length > 0) {
                    this.state.currentFrameIndex = this.state.frames.length - 1;
                    this.state.currentFrameDate = this.state.frames[this.state.currentFrameIndex]?.date || null;
                }
                this._emit_state();
                if (callback) callback();
            },
            undefined,
            request_controller.signal
        );
    }

    play() {
        if (!this.state.active || !this.state.supported) return;
        if (this.play_timer) return;
        if (this.state.preloading) return;

        if (!this.state.frames.length) return;

        const self = this;
        const preload_token = ++this.current_render_token;

        const _start_playback = () => {
            if (preload_token !== self.current_render_token) return;
            self.state.preloading = false;
            self.state.preloadTotal = 0;
            self.state.preloadLoaded = 0;
            self.state.playing = true;
            self.state.currentFrameIndex = 0;
            self.plot_frame(0, { preserve_playing_state: true });
            self._schedule_next_tick();
        };

        const _finish_remaining_render = () => {
            if (preload_token !== self.current_render_token) return;
            const needs_render = self.state.frames.filter(f =>
                f?.url && self.frame_factory_cache[f.url] && !self.frame_render_cache[f.url]
            );
            if (needs_render.length === 0) {
                _start_playback();
                return;
            }
            var extra_done = 0;
            needs_render.forEach(f => {
                precompute_render_data(self.frame_factory_cache[f.url], (render_data) => {
                    if (preload_token !== self.current_render_token) return;
                    self.frame_render_cache[f.url] = render_data;
                    extra_done++;
                    self.state.preloadLoaded++;
                    self._emit_state();
                    if (extra_done >= needs_render.length) {
                        _start_playback();
                    }
                });
            });
        };

        const uncached = this.state.frames.filter(f => f && f.url && !this.frame_factory_cache[f.url]);
        if (uncached.length === 0) {
            var needs_render = this.state.frames.filter(f =>
                f?.url && this.frame_factory_cache[f.url] && !this.frame_render_cache[f.url]
            );
            if (needs_render.length === 0) {
                _start_playback();
                return;
            }
            this.state.preloading = true;
            this.state.preloadTotal = this.state.frames.length;
            this.state.preloadLoaded = this.state.frames.length - needs_render.length;
            this._emit_state();
            _finish_remaining_render();
            return;
        }

        this.state.preloading = true;
        this.state.preloadTotal = this.state.frames.length;
        this.state.preloadLoaded = this.state.frames.length - uncached.length;
        this._emit_state();

        var completed = 0;
        var total = uncached.length;

        const check_done = () => {
            if (preload_token !== this.current_render_token) return;
            if (completed >= total) {
                _finish_remaining_render();
            }
        };

        const CONCURRENCY = 4;
        var queue_idx = 0;
        const process_next = () => {
            if (preload_token !== this.current_render_token) return;
            if (queue_idx >= uncached.length) return;
            const frame = uncached[queue_idx++];
            loaders_nexrad.return_level_3_factory_from_url(frame.url, (factory) => {
                if (preload_token !== this.current_render_token) return;
                if (factory) {
                    this.frame_factory_cache[frame.url] = factory;
                    precompute_render_data(factory, (render_data) => {
                        if (preload_token !== this.current_render_token) return;
                        this.frame_render_cache[frame.url] = render_data;
                        completed++;
                        this.state.preloadLoaded = this.state.frames.length - uncached.length + completed;
                        this._emit_state();
                        process_next();
                        check_done();
                    });
                } else {
                    completed++;
                    this.state.preloadLoaded = this.state.frames.length - uncached.length + completed;
                    this._emit_state();
                    process_next();
                    check_done();
                }
            });
        };

        for (var i = 0; i < Math.min(CONCURRENCY, uncached.length); i++) {
            process_next();
        }
    }

    pause() {
        this.state.playing = false;
        if (this.play_timer) {
            cancelAnimationFrame(this.play_timer);
            this.play_timer = null;
        }
        this._emit_state();
    }

    stop() {
        this._cancel_preload();
        this.pause();
        if (this.fetch_controller) {
            this.fetch_controller.abort();
            this.fetch_controller = null;
        }
    }

    toggle_play() {
        if (this.state.playing) {
            this.pause();
        } else {
            this.play();
        }
    }

    toggle_play_stop() {
        if (this.state.playing || this.state.preloading) {
            this._cancel_preload();
            this.stop_and_reset_to_latest();
        } else {
            this.play();
        }
    }

    _cancel_preload() {
        if (this.state.preloading) {
            this.current_render_token++;
            this.state.preloading = false;
            this.state.preloadTotal = 0;
            this.state.preloadLoaded = 0;
            this._emit_state();
        }
    }

    step_forward() {
        this.pause();
        this._advance(1);
    }

    step_back() {
        this.pause();
        this._advance(-1);
    }

    set_speed(multiplier) {
        const parsed = parseFloat(multiplier);
        this.state.speedMultiplier = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SPEED_MULTIPLIER;
        this._emit_state();
        if (this.state.playing) {
            this.pause();
            this.play();
        }
    }

    set_frame_count(count) {
        const parsed = parseInt(count);
        if (!Number.isFinite(parsed) || parsed < 1) return;
        this.state.frameCount = parsed;
        const should_resume_play = this.state.playing;
        this.pause();
        this.refresh_frames(() => {
            if (this.state.frames.length === 0) {
                this._emit_state();
                return;
            }
            this.plot_frame(this.state.frames.length - 1);
            if (should_resume_play) {
                this.play();
            }
        });
    }

    set_frame_index(index) {
        const parsed = parseInt(index);
        if (!Number.isFinite(parsed)) return;
        const max_idx = Math.max(this.state.frames.length - 1, 0);
        const clamped = Math.max(0, Math.min(max_idx, parsed));
        this.pause();
        this.plot_frame(clamped);
    }

    jump_to_ratio(ratio) {
        if (!this.state.frames.length) return;
        const parsed = parseFloat(ratio);
        if (!Number.isFinite(parsed)) return;
        const idx = Math.round((this.state.frames.length - 1) * Math.max(0, Math.min(1, parsed)));
        this.set_frame_index(idx);
    }

    stop_and_reset_to_latest() {
        this.pause();
        if (window?.stormTrackData?.current_RadarUpdater) {
            window.stormTrackData.current_RadarUpdater.enable();
        }
        this.refresh_frames(() => {
            if (!this.state.frames.length) {
                this._emit_state();
                return;
            }
            this.plot_frame(this.state.frames.length - 1);
        });
    }

    plot_frame(index, options = {}) {
        if (!this.state.frames.length) return;
        const frame = this.state.frames[index];
        if (!frame?.url) return;

        const token = ++this.current_render_token;

        const cached_render = this.frame_render_cache[frame.url];
        const cached_factory = this.frame_factory_cache[frame.url];
        if (cached_render && cached_factory) {
            var did_swap = plot_to_map.update_radar_buffers(
                cached_render.vertices, cached_render.colors,
                cached_render.product, cached_factory
            );
            if (did_swap) {
                this._after_plot(index, cached_factory, token);
                return;
            }
        }

        if (cached_factory) {
            cached_factory.plot();
            this._after_plot(index, cached_factory, token);
            this._preload_neighbors(index);
            return;
        }

        loaders_nexrad.return_level_3_factory_from_url(frame.url, (factory) => {
            if (!factory) return;
            if (token !== this.current_render_token) return;
            this.frame_factory_cache[frame.url] = factory;
            factory.plot();
            this._after_plot(index, factory, token);
            this._preload_neighbors(index);
        });
    }

    _after_plot(index, factory, token) {
        if (token !== this.current_render_token) return;
        const state = this.state;
        if ((state.playing || state.preloading) && window?.stormTrackData?.current_RadarUpdater) {
            window.stormTrackData.current_RadarUpdater.disable();
        }
        state.currentFrameIndex = index;
        state.currentFrameDate = factory?.get_date?.() || state.frames[index]?.date || null;
        state.currentFrameFactory = factory || null;
        this._emit_state();
    }

    _preload_neighbors(index) {
        const neighbors = [index - 1, index + 1];
        for (var i = 0; i < neighbors.length; i++) {
            const neighbor_idx = neighbors[i];
            if (neighbor_idx < 0 || neighbor_idx >= this.state.frames.length) continue;
            const frame = this.state.frames[neighbor_idx];
            if (!frame?.url || this.frame_factory_cache[frame.url]) continue;
            loaders_nexrad.return_level_3_factory_from_url(frame.url, (factory) => {
                if (!factory) return;
                this.frame_factory_cache[frame.url] = factory;
            });
        }
    }

    _advance(step_dir) {
        if (!this.state.frames.length) return;
        const max_idx = this.state.frames.length - 1;
        var next_idx = this.state.currentFrameIndex + step_dir;
        if (next_idx > max_idx) next_idx = 0;
        if (next_idx < 0) next_idx = max_idx;

        if (next_idx < 0) next_idx = 0;
        if (next_idx > max_idx) next_idx = max_idx;
        this.plot_frame(next_idx);
    }

    _schedule_next_tick() {
        if (!this.state.playing) return;
        const frame_delay = BASE_FRAME_MS / this.state.speedMultiplier;
        var delay = frame_delay;
        const max_idx = this.state.frames.length - 1;
        if (this.state.currentFrameIndex === max_idx && max_idx > 0) {
            delay += ENDPOINT_DWELL_MS;
        }

        const start = performance.now();
        const tick = () => {
            if (!this.state.playing) return;
            if (performance.now() - start >= delay) {
                this._advance(1);
                this._schedule_next_tick();
            } else {
                this.play_timer = requestAnimationFrame(tick);
            }
        };
        this.play_timer = requestAnimationFrame(tick);
    }

    _emit_state() {
        window.dispatchEvent(new CustomEvent('radarLoopStateChanged', { detail: this.state }));
    }
}

module.exports = RadarLoopController;
