/**
 * Persists settings to localStorage so they survive page reloads.
 */
const STORAGE_KEY = 'stormTrackPro_settings';
const LEGACY_STORAGE_KEYS = ['stormTrackPro_settings'];

const DEFAULTS = {
    radar: true,
    usRadar: false,
    radarOpacity: 85,
    radarSiteLegacyStyle: false,
    radarSweep: true,
    radarRadius: false,
    mapStyle: 'dark',
    focusNewAlerts: false,
    dealiasRegionBased: true,
    dealiasTornadic: false,
    currentStation: null,
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
    tornadoWarningBeepVolume: 100,
    surfaceFronts: false,
    weatherRadio: false,
    timezones: false,
    testAlerts: false,
    radarLoopSpeed: 5,
    radarLoopFrameCount: 14,
    colortableREF: 'REF1',
    colortableVEL: 'VEL1',
    colortableRHO: 'RHO1',
    colortableZDR: 'ZDR1',
    colortableKDP: 'KDP1',
    colortableDVL: 'DVL1'
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
    s.radarSiteLegacyStyle = $('#armrRadarSiteLegacyStyleBtnSwitchElem').length && $('#armrRadarSiteLegacyStyleBtnSwitchElem').is(':checked');
    s.radarSweep = $('#armrRadarSweepBtnSwitchElem').length && $('#armrRadarSweepBtnSwitchElem').is(':checked');
    s.radarRadius = $('#armrRadarRadiusBtnSwitchElem').length && $('#armrRadarRadiusBtnSwitchElem').is(':checked');
    s.mapStyle = 'dark';
    if ($('#armrSatelliteMapBtnSwitchElem').length && $('#armrSatelliteMapBtnSwitchElem').is(':checked')) s.mapStyle = 'satellite';
    else if ($('#armrLightMapBtnSwitchElem').length && $('#armrLightMapBtnSwitchElem').is(':checked')) s.mapStyle = 'light';
    s.focusNewAlerts = $('#armrFocusNewAlertsBtnSwitchElem').length && $('#armrFocusNewAlertsBtnSwitchElem').is(':checked');
    s.dealiasRegionBased = true;
    s.dealiasTornadic = false;
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
    s.surfaceFronts = $('#armrSurfaceFrontsBtnSwitchElem').length ? $('#armrSurfaceFrontsBtnSwitchElem').is(':checked') : DEFAULTS.surfaceFronts;
    s.weatherRadio = $('#armrWeatherRadioBtnSwitchElem').length ? $('#armrWeatherRadioBtnSwitchElem').is(':checked') : DEFAULTS.weatherRadio;
    s.timezones = $('#armrTimezonesBtnSwitchElem').length ? $('#armrTimezonesBtnSwitchElem').is(':checked') : DEFAULTS.timezones;
    s.testAlerts = $('#devTestAlertsSwitchElem').length ? $('#devTestAlertsSwitchElem').is(':checked') : DEFAULTS.testAlerts;
    s.radarLoopSpeed = $('#radarLoopSpeedSelect').length ? parseInt($('#radarLoopSpeedSelect').val(), 10) || DEFAULTS.radarLoopSpeed : DEFAULTS.radarLoopSpeed;
    s.radarLoopFrameCount = $('#radarLoopFrameCountSelect').length ? parseInt($('#radarLoopFrameCountSelect').val(), 10) || DEFAULTS.radarLoopFrameCount : DEFAULTS.radarLoopFrameCount;
    var ctableGroups = ['REF', 'VEL', 'RHO', 'ZDR', 'KDP', 'DVL'];
    for (var i = 0; i < ctableGroups.length; i++) {
        var g = ctableGroups[i];
        var $sel = $('#' + g + '_ctable_options .ctableOption-selected');
        s['colortable' + g] = $sel.length ? ($sel.attr('name') || g + '1') : DEFAULTS['colortable' + g];
    }
    return s;
}

function saveFromDom() {
    save(get_settings_from_dom());
}

module.exports = {
    load,
    save,
    get_settings_from_dom,
    saveFromDom,
    DEFAULTS
};
