var settings_store = require('../core/menu/settings_store');

var TORNADO_WARNING_SOUND_PATH = '/sounds/tornado_warning.mp3';
var TORNADO_WARNING_ISSUED_VOICE_PATH = '/sounds/tornado_warning_issued_voice.mp3';
var TORNADO_WARNING_UPDATED_VOICE_PATH = '/sounds/tornado_warning_updated_voice.mp3';
var TORNADO_WARNING_UPGRADED_VOICE_PATH = '/sounds/upgraded_tornado_warning.mp3';
var TORNADO_WARNING_FOLLOWUP_VOLUME_OFFSET_PERCENT = 5;
var _playbackQueue = Promise.resolve();

function _clamp_volume(volumePercent) {
    var n = parseInt(volumePercent, 10);
    if (!Number.isFinite(n)) return 25;
    if (n < 0) return 0;
    if (n > 100) return 100;
    return n;
}

function setVolume(val) {
    var volume = _clamp_volume(val);
    var baseAudio = new Audio(TORNADO_WARNING_SOUND_PATH);
    baseAudio.volume = volume / 100;
}

function _play_clip(audioPath, volume) {
    var audio = new Audio(audioPath);
    var clampedVolume = _clamp_volume(volume);
    audio.volume = clampedVolume / 100;

    return new Promise(function(resolve, reject) {
        var done = false;
        function cleanup() {
            audio.removeEventListener('ended', onEnded);
            audio.removeEventListener('error', onError);
        }
        function onEnded() {
            if (done) return;
            done = true;
            cleanup();
            resolve();
        }
        function onError() {
            if (done) return;
            done = true;
            cleanup();
            reject(new Error('Failed to play audio: ' + audioPath));
        }

        audio.addEventListener('ended', onEnded);
        audio.addEventListener('error', onError);

        var playPromise = audio.play();
        if (playPromise && typeof playPromise.then === 'function') {
            playPromise.catch(function(err) {
                if (done) return;
                done = true;
                cleanup();
                reject(err);
            });
        }
    });
}

function _enqueue_play_sequence(sequence) {
    _playbackQueue = _playbackQueue
        .catch(function() {})
        .then(function() {
            return sequence();
        });
    return _playbackQueue;
}

function _play_tornado_sequence(volume, followupPath) {
    var baseVolume = _clamp_volume(volume);
    return _enqueue_play_sequence(function() {
        return _play_clip(TORNADO_WARNING_SOUND_PATH, baseVolume).then(function() {
            if (!followupPath) return;
            return _play_clip(followupPath, _clamp_volume(baseVolume + TORNADO_WARNING_FOLLOWUP_VOLUME_OFFSET_PERCENT));
        });
    });
}

function playTornadoWarningBeep() {
    var s = settings_store.load();
    if (!s.tornadoWarningBeep) return;
    var volume = s.tornadoWarningBeepVolume != null ? s.tornadoWarningBeepVolume : 25;
    return _play_tornado_sequence(volume, null);
}

function testTornadoWarningBeep(overrideVolume) {
    var s = settings_store.load();
    var volume = overrideVolume != null ? overrideVolume : (s.tornadoWarningBeepVolume != null ? s.tornadoWarningBeepVolume : 25);
    return _play_tornado_sequence(volume, null);
}

function testTornadoWarningSequence(mode, overrideVolume) {
    var s = settings_store.load();
    var volume = overrideVolume != null ? overrideVolume : (s.tornadoWarningBeepVolume != null ? s.tornadoWarningBeepVolume : 25);
    var normalizedMode = String(mode || 'base').trim().toLowerCase();
    var followupPath = null;
    if (normalizedMode === 'issued') followupPath = TORNADO_WARNING_ISSUED_VOICE_PATH;
    else if (normalizedMode === 'updated') followupPath = TORNADO_WARNING_UPDATED_VOICE_PATH;
    else if (normalizedMode === 'upgraded') followupPath = TORNADO_WARNING_UPGRADED_VOICE_PATH;
    return _play_tornado_sequence(volume, followupPath);
}

function _is_exact_tornado_warning_event(eventName) {
    return String(eventName || '').trim().toLowerCase() === 'tornado warning';
}

function _is_upgraded_tornado_warning(detail) {
    var extra = String(detail && detail.extra ? detail.extra : '').toLowerCase();
    if (!extra) return false;
    if (extra.indexOf('upgraded') !== -1) return true;
    return extra.indexOf('observed') !== -1 && extra.indexOf('radar indicated') !== -1;
}

function init() {
    window.addEventListener('alertNotification', function (e) {
        var detail = e.detail || {};
        if (!_is_exact_tornado_warning_event(detail.event)) return;

        var s = settings_store.load();
        if (!s.tornadoWarningBeep) return;
        var volume = s.tornadoWarningBeepVolume != null ? s.tornadoWarningBeepVolume : 25;

        if (detail.type === 'new') {
            if (detail.tornadoStatus === 'updated') {
                _play_tornado_sequence(volume, TORNADO_WARNING_UPDATED_VOICE_PATH);
                return;
            }
            _play_tornado_sequence(volume, TORNADO_WARNING_ISSUED_VOICE_PATH);
            return;
        }
        if (detail.type !== 'updated') return;
        if (_is_upgraded_tornado_warning(detail)) {
            _play_tornado_sequence(volume, TORNADO_WARNING_UPGRADED_VOICE_PATH);
            return;
        }
        _play_tornado_sequence(volume, TORNADO_WARNING_UPDATED_VOICE_PATH);
    });
}

module.exports = {
    init: init,
    playTornadoWarningBeep: playTornadoWarningBeep,
    testTornadoWarningBeep: testTornadoWarningBeep,
    testTornadoWarningSequence: testTornadoWarningSequence,
    setVolume: setVolume
};
