const MUSIC_BASE_ATTENUATION = 0.5;
const DUCK_VOLUME_RATIO = 0.15;
const DUCK_FADE_STEP_MS = 30;

class LiveModeMusicController {
    constructor(options) {
        this.settingsStore = options.settingsStore;
        this.tracks = Array.isArray(options.tracks) ? options.tracks.slice() : [];

        this.musicAudio = null;
        this.musicPlaying = false;
        this.musicVolume = 0.15;
        this.musicShuffled = [];
        this.musicIndex = 0;
        this.songPopupEl = null;
        this.songPopupHost = null;
        this.songPopupTimeout = null;
        this.musicDucked = false;
        this.duckFadeInterval = null;
    }

    extractSongTitle(path) {
        return path.replace(/^.*\//, '').replace(/\.\w+$/, '');
    }

    ensureSongPopupEl() {
        if (typeof document === 'undefined') return;
        var host = document.getElementById('liveModeOverlay') || document.body;
        if (!this.songPopupEl) {
            this.songPopupEl = document.createElement('div');
            this.songPopupEl.className = 'lmSongPopup';
            host.appendChild(this.songPopupEl);
            this.songPopupHost = host;
            return;
        }
        if (this.songPopupHost !== host || this.songPopupEl.parentElement !== host) {
            host.appendChild(this.songPopupEl);
            this.songPopupHost = host;
        }
    }

    positionSongPopup() {
        if (typeof document === 'undefined' || !this.songPopupEl) return;
        var badge = document.getElementById('liveModeBadge') || document.querySelector('.liveModeBadge');
        if (!badge) return;
        var host = this.songPopupHost || this.songPopupEl.parentElement || document.body;
        var badgeRect = badge.getBoundingClientRect();
        var hostRect = host.getBoundingClientRect ? host.getBoundingClientRect() : { top: 0, left: 0, width: window.innerWidth };
        var tuckUnderPx = Math.round(Math.min(badgeRect.width * 0.28, 16));
        var gapPx = 0;
        var maxBannerWidthPx = Math.max(180, Math.floor(badgeRect.left + tuckUnderPx - 20));
        var safeRightTextInsetPx = tuckUnderPx + 8;
        this.songPopupEl.style.top = Math.max(0, badgeRect.top - hostRect.top) + 'px';
        this.songPopupEl.style.height = Math.max(26, badgeRect.height) + 'px';
        this.songPopupEl.style.right = Math.max(0, (hostRect.width - (badgeRect.left - hostRect.left)) - tuckUnderPx + gapPx) + 'px';
        this.songPopupEl.style.maxWidth = maxBannerWidthPx + 'px';
        this.songPopupEl.style.setProperty('--lmSongPopupSafeRight', safeRightTextInsetPx + 'px');
    }

    showSongPopup(title) {
        if (typeof document === 'undefined') return;
        this.ensureSongPopupEl();
        if (!this.songPopupEl) return;
        if (this.songPopupTimeout) clearTimeout(this.songPopupTimeout);
        this.songPopupEl.textContent = title;
        this.songPopupEl.classList.remove('lmSongPopup-visible', 'lmSongPopup-fading');
        this.positionSongPopup();

        void this.songPopupEl.offsetWidth;
        this.songPopupEl.classList.add('lmSongPopup-visible');
        var self = this;
        this.songPopupTimeout = setTimeout(function () {
            self.songPopupEl.classList.add('lmSongPopup-fading');
            self.songPopupTimeout = setTimeout(function () {
                self.songPopupEl.classList.remove('lmSongPopup-visible', 'lmSongPopup-fading');
            }, 500);
        }, 4000);
    }

    shuffleTracks() {
        this.musicShuffled = this.tracks.slice().sort(function () { return Math.random() - 0.5; });
        this.musicIndex = 0;
    }

    playNextTrack() {
        if (!this.musicPlaying) return;
        if (this.musicIndex >= this.musicShuffled.length) {
            this.shuffleTracks();
        }
        var src = this.musicShuffled[this.musicIndex++];
        if (this.musicAudio) {
            try { this.musicAudio.pause(); } catch (_) {}
            this.musicAudio = null;
        }
        this.musicAudio = new Audio(src);
        this.musicAudio.volume = this.musicVolume;
        this.showSongPopup(this.extractSongTitle(src));

        var self = this;
        this.musicAudio.addEventListener('ended', function () {
            self.playNextTrack();
        });
        this.musicAudio.addEventListener('error', function () {
            console.warn('[LiveMode Music] Failed to load:', src);
            setTimeout(function () { self.playNextTrack(); }, 1000);
        });
        var p = this.musicAudio.play();
        if (p && p.catch) p.catch(function (e) {
            console.warn('[LiveMode Music] Play blocked:', e.message);
        });
    }

    start() {
        if (this.musicPlaying) return;
        this.musicPlaying = true;
        var saved = this.settingsStore.load();
        this.musicVolume = (saved.liveModeVolume || 15) / 100 * MUSIC_BASE_ATTENUATION;
        this.shuffleTracks();

        var self = this;
        function attempt() {
            if (!self.musicPlaying) return;
            self.playNextTrack();
        }

        if (this.musicAudio === null && typeof document !== 'undefined') {
            var resumeOnGesture = function () {
                document.removeEventListener('click', resumeOnGesture);
                document.removeEventListener('keydown', resumeOnGesture);
                if (self.musicPlaying && (!self.musicAudio || self.musicAudio.paused)) {
                    self.playNextTrack();
                }
            };
            attempt();
            if (this.musicAudio && this.musicAudio.paused) {
                document.addEventListener('click', resumeOnGesture);
                document.addEventListener('keydown', resumeOnGesture);
            }
            return;
        }
        attempt();
    }

    stop() {
        this.musicPlaying = false;
        if (this.musicAudio) {
            try { this.musicAudio.pause(); } catch (_) {}
            this.musicAudio = null;
        }
        if (this.songPopupEl) {
            this.songPopupEl.classList.remove('lmSongPopup-visible', 'lmSongPopup-fading');
        }
        if (this.songPopupTimeout) {
            clearTimeout(this.songPopupTimeout);
            this.songPopupTimeout = null;
        }
    }

    setVolume(pct) {
        this.musicVolume = Math.max(0, Math.min(1, pct / 100)) * MUSIC_BASE_ATTENUATION;
        if (this.musicAudio && !this.musicDucked) this.musicAudio.volume = this.musicVolume;
    }

    clearDuckInterval() {
        if (this.duckFadeInterval) {
            clearInterval(this.duckFadeInterval);
            this.duckFadeInterval = null;
        }
    }

    duck(fadeDurationMs) {
        if (!this.musicAudio || !this.musicPlaying) return;
        this.clearDuckInterval();
        this.musicDucked = true;
        var startVol = this.musicAudio.volume;
        var targetVol = this.musicVolume * DUCK_VOLUME_RATIO;
        var duration = fadeDurationMs || 400;
        var steps = Math.max(1, Math.round(duration / DUCK_FADE_STEP_MS));
        var delta = (startVol - targetVol) / steps;
        var step = 0;
        var self = this;
        this.duckFadeInterval = setInterval(function () {
            step++;
            if (!self.musicAudio || step >= steps) {
                self.clearDuckInterval();
                if (self.musicAudio) self.musicAudio.volume = targetVol;
                return;
            }
            self.musicAudio.volume = Math.max(targetVol, startVol - delta * step);
        }, DUCK_FADE_STEP_MS);
    }

    unduck(fadeDurationMs) {
        if (!this.musicDucked) return;
        this.clearDuckInterval();
        this.musicDucked = false;
        if (!this.musicAudio || !this.musicPlaying) return;
        var startVol = this.musicAudio.volume;
        var targetVol = this.musicVolume;
        var duration = fadeDurationMs || 600;
        var steps = Math.max(1, Math.round(duration / DUCK_FADE_STEP_MS));
        var delta = (targetVol - startVol) / steps;
        var step = 0;
        var self = this;
        this.duckFadeInterval = setInterval(function () {
            step++;
            if (!self.musicAudio || step >= steps) {
                self.clearDuckInterval();
                if (self.musicAudio) self.musicAudio.volume = targetVol;
                return;
            }
            self.musicAudio.volume = Math.min(targetVol, startVol + delta * step);
        }, DUCK_FADE_STEP_MS);
    }
}

module.exports = LiveModeMusicController;
