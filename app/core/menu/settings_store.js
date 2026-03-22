/**
 * Persists settings to localStorage so they survive page reloads.
 */
const STORAGE_KEY = 'stormTrackPro_settings';
const LEGACY_STORAGE_KEYS = ['stormTrackPro_settings'];

const DEFAULTS = {
    radar: true,
    usRadar: false,
    radarOpacity: 85,
    stormTracks: true,
    lightning: false,
    radarSiteLegacyStyle: false,
    radarSweep: true,
    radarRadius: false,
    mapStyle: 'dark',
    focusNewAlerts: false,
    dealiasRegionBased: true,
    dealiasTornadic: false,
    currentStation: null,
    devAutoUpdateMode: 'reloadWindow',
    gateFilterMin: 10,
    gateFilterMax: 85,
    alertFillOpacity: 10,
    alertBorderScale: 75,
    alertBlinkColor: '#000000',
    alertBlinkEnabled: true,
    alertBlinkDuration: 30,
    warningCounter: false,
    audibleAlerts: false,
    ttsVolume: 100,
    tornadoWarningBeep: false,
    tornadoWarningBeepVolume: 100
};

function _load_raw() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') return parsed;
        }
        for (const legacyKey of LEGACY_STORAGE_KEYS) {
            const legacyRaw = localStorage.getItem(legacyKey);
            if (!legacyRaw) continue;
            const legacyParsed = JSON.parse(legacyRaw);
            if (legacyParsed && typeof legacyParsed === 'object') {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(legacyParsed));
                return legacyParsed;
            }
        }
    } catch (_) {}
    return {};
}

function load() {
    const saved = _load_raw();
    const merged = {};
    for (const key of Object.keys(DEFAULTS)) {
        merged[key] = saved.hasOwnProperty(key) ? saved[key] : DEFAULTS[key];
    }
    // Full US radar is intentionally disabled in the UI; keep this off in persisted state.
    merged.usRadar = false;
    return merged;
}

function save(settings) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (_) {}
}

function get_settings_from_dom() {
    const s = {};
    s.currentStation = (typeof window !== 'undefined' && window.stormTrackData?.currentStation) || null;
    s.radar = $('#armrRadarVisBtnSwitchElem').length && $('#armrRadarVisBtnSwitchElem').is(':checked');
    s.usRadar = false;
    s.radarOpacity = $('#armrRadarOpacitySlider').length ? parseInt($('#armrRadarOpacitySlider').val(), 10) : DEFAULTS.radarOpacity;
    s.stormTracks = $('#armrSTVisBtnSwitchElem').length && $('#armrSTVisBtnSwitchElem').is(':checked');
    s.lightning = $('#armrLightningVisBtnSwitchElem').length && $('#armrLightningVisBtnSwitchElem').is(':checked');
    s.radarSiteLegacyStyle = $('#armrRadarSiteLegacyStyleBtnSwitchElem').length && $('#armrRadarSiteLegacyStyleBtnSwitchElem').is(':checked');
    s.radarSweep = $('#armrRadarSweepBtnSwitchElem').length && $('#armrRadarSweepBtnSwitchElem').is(':checked');
    s.radarRadius = $('#armrRadarRadiusBtnSwitchElem').length && $('#armrRadarRadiusBtnSwitchElem').is(':checked');
    s.mapStyle = 'dark';
    if ($('#armrSatelliteMapBtnSwitchElem').length && $('#armrSatelliteMapBtnSwitchElem').is(':checked')) s.mapStyle = 'satellite';
    else if ($('#armrLightMapBtnSwitchElem').length && $('#armrLightMapBtnSwitchElem').is(':checked')) s.mapStyle = 'light';
    s.focusNewAlerts = $('#armrFocusNewAlertsBtnSwitchElem').length && $('#armrFocusNewAlertsBtnSwitchElem').is(':checked');
    s.dealiasRegionBased = true;
    s.dealiasTornadic = false;
    const selectedMode = $('#appDevAutoUpdateModeSelect').val();
    s.devAutoUpdateMode = (selectedMode === 'restartApp' || selectedMode === 'off') ? selectedMode : 'reloadWindow';
    s.gateFilterMin = $('#gateFilterMinSlider').length ? parseInt($('#gateFilterMinSlider').val(), 10) : DEFAULTS.gateFilterMin;
    s.gateFilterMax = $('#gateFilterMaxSlider').length ? parseInt($('#gateFilterMaxSlider').val(), 10) : DEFAULTS.gateFilterMax;
    s.alertFillOpacity = $('#alertFillOpacitySlider').length ? parseInt($('#alertFillOpacitySlider').val(), 10) : DEFAULTS.alertFillOpacity;
    s.alertBorderScale = $('#alertBorderScaleSlider').length ? parseInt($('#alertBorderScaleSlider').val(), 10) : DEFAULTS.alertBorderScale;
    s.alertBlinkColor = $('#alertBlinkColorPicker').length ? $('#alertBlinkColorPicker').val() : DEFAULTS.alertBlinkColor;
    s.alertBlinkEnabled = $('#alertBlinkEnabledSwitchElem').length ? $('#alertBlinkEnabledSwitchElem').is(':checked') : DEFAULTS.alertBlinkEnabled;
    s.alertBlinkDuration = $('#alertBlinkDurationSelect').length ? parseInt($('#alertBlinkDurationSelect').val(), 10) : DEFAULTS.alertBlinkDuration;
    s.warningCounter = $('#armrWarningCounterBtnSwitchElem').length ? $('#armrWarningCounterBtnSwitchElem').is(':checked') : DEFAULTS.warningCounter;
    s.audibleAlerts = $('#armrAudibleAlertsBtnSwitchElem').length ? $('#armrAudibleAlertsBtnSwitchElem').is(':checked') : DEFAULTS.audibleAlerts;
    s.ttsVolume = $('#ttsVolumeSlider').length ? parseInt($('#ttsVolumeSlider').val(), 10) : DEFAULTS.ttsVolume;
    s.tornadoWarningBeep = $('#tornadoBeepEnabledSwitchElem').length ? $('#tornadoBeepEnabledSwitchElem').is(':checked') : DEFAULTS.tornadoWarningBeep;
    s.tornadoWarningBeepVolume = $('#tornadoBeepVolumeSlider').length ? parseInt($('#tornadoBeepVolumeSlider').val(), 10) : DEFAULTS.tornadoWarningBeepVolume;
    return s;
}

module.exports = {
    load,
    save,
    get_settings_from_dom,
    DEFAULTS
};
