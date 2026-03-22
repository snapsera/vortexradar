var settings_store = require('../core/menu/settings_store');

var _voice = null;
var _voicesLoaded = false;

var PREFERRED_VOICES = [
    'microsoft zira',
    'zira',
    'samantha',
    'google us english',
    'google uk english female',
    'female'
];

function _pick_voice() {
    var voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;

    var lowerNames = voices.map(function (v) { return v.name.toLowerCase(); });

    for (var p = 0; p < PREFERRED_VOICES.length; p++) {
        var pref = PREFERRED_VOICES[p];
        for (var i = 0; i < voices.length; i++) {
            if (lowerNames[i].indexOf(pref) !== -1) return voices[i];
        }
    }

    for (var i = 0; i < voices.length; i++) {
        if (voices[i].lang && voices[i].lang.indexOf('en') === 0) return voices[i];
    }

    return voices[0];
}

function _load_voices() {
    _voice = _pick_voice();
    _voicesLoaded = !!_voice;
}

function speak(text) {
    if (!window.speechSynthesis) return;

    var s = settings_store.load();
    if (!s.audibleAlerts) return;

    if (!_voicesLoaded) _load_voices();

    window.speechSynthesis.cancel();

    var utterance = new SpeechSynthesisUtterance(text);
    if (_voice) utterance.voice = _voice;
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = (s.ttsVolume != null ? s.ttsVolume : 100) / 100;
    window.speechSynthesis.speak(utterance);
}

function init() {
    if (!window.speechSynthesis) return;

    _load_voices();

    if (!_voicesLoaded) {
        window.speechSynthesis.onvoiceschanged = function () {
            _load_voices();
        };
    }
}

module.exports = { init: init, speak: speak };
