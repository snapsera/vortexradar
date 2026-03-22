var settings_store = require('../core/menu/settings_store');

var _audioCtx = null;
var _masterGain = null;

function _getAudioContext() {
    if (!_audioCtx) {
        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (_audioCtx.state === 'suspended') {
        _audioCtx.resume();
    }
    return _audioCtx;
}

function _getMasterGain() {
    var ctx = _getAudioContext();
    if (!_masterGain) {
        _masterGain = ctx.createGain();
        _masterGain.connect(ctx.destination);
    }
    return _masterGain;
}

function setVolume(val) {
    var ctx = _getAudioContext();
    var gain = _getMasterGain();
    gain.gain.setValueAtTime(val / 100, ctx.currentTime);
}

function _playBeeps(volume) {
    var ctx = _getAudioContext();
    var master = _getMasterGain();
    master.gain.setValueAtTime(volume / 100, ctx.currentTime);

    var BEEP_FREQ = 660;
    var BEEP_DURATION = 0.25;
    var BEEP_GAP = 0.15;

    for (var i = 0; i < 3; i++) {
        var startTime = ctx.currentTime + i * (BEEP_DURATION + BEEP_GAP);

        var osc = ctx.createOscillator();
        var env = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.value = BEEP_FREQ;

        env.gain.setValueAtTime(1, startTime);
        env.gain.setValueAtTime(1, startTime + BEEP_DURATION - 0.03);
        env.gain.linearRampToValueAtTime(0, startTime + BEEP_DURATION);

        osc.connect(env);
        env.connect(master);

        osc.start(startTime);
        osc.stop(startTime + BEEP_DURATION + 0.01);
    }
}

function playTornadoWarningBeep() {
    var s = settings_store.load();
    if (!s.tornadoWarningBeep) return;
    var volume = s.tornadoWarningBeepVolume != null ? s.tornadoWarningBeepVolume : 100;
    _playBeeps(volume);
}

function testTornadoWarningBeep() {
    var s = settings_store.load();
    var volume = s.tornadoWarningBeepVolume != null ? s.tornadoWarningBeepVolume : 100;
    _playBeeps(volume);
}

function init() {
    window.addEventListener('alertNotification', function (e) {
        var detail = e.detail || {};
        if (detail.type !== 'new') return;
        var event = (detail.event || '').toLowerCase();
        if (event.indexOf('tornado') !== -1 && event.indexOf('warning') !== -1) {
            playTornadoWarningBeep();
        }
    });
}

module.exports = {
    init: init,
    playTornadoWarningBeep: playTornadoWarningBeep,
    testTornadoWarningBeep: testTornadoWarningBeep,
    setVolume: setVolume
};
