/**
 * Alerts display state - which alert types are enabled for map polygons and alerts list.
 * Stored in localStorage. Used by filter_alerts and alerts_display_popup.
 */
const STORAGE_KEY = 'stormTrackPro_alerts_display_types';
const CATEGORY_STORAGE_KEY = 'stormTrackPro_alerts_display_categories';
const LEGACY_STORAGE_KEY = 'stormTrackPro_alerts_display_types';
const LEGACY_CATEGORY_STORAGE_KEY = 'stormTrackPro_alerts_display_categories';
let _savedStateCache = null;
let _categoryStateCache = null;
let _resolvedDisplayStateCache = null;

const ALERT_TYPES_BY_CATEGORY = {
    'Severe Weather': [
        'Tornado Warning', 'Severe Thunderstorm Warning',
        'Special Weather Statement'
    ],
    'Winter': [
        'Blizzard Warning', 'Winter Storm Warning',
        'Lake Effect Snow Warning', 'Snow Squall Warning',
        'Ice Storm Warning', 'Winter Weather Advisory', 'Wind Chill Warning',
        'Wind Chill Advisory', 'Freeze Warning', 'Frost Advisory',
        'Avalanche Warning', 'Avalanche Advisory', 'Avalanche Watch'
    ],
    'Fire': [
        'Red Flag Warning', 'Fire Warning', 'Extreme Fire Danger'
    ],
    'Marine': [
        'Special Marine Warning',
        'Gale Warning', 'Storm Warning',
        'Small Craft Advisory', 'Lake Wind Advisory',
        'Hazardous Seas Warning', 'Heavy Freezing Spray Warning',
        'Marine Weather Statement',
        'Rip Current Statement', 'Beach Hazards Statement'
    ],
    'Flood': [
        'Flash Flood Warning', 'Flood Warning', 'Flood Advisory',
        'Coastal Flood Warning', 'Lakeshore Flood Warning',
        'Coastal Flood Statement', 'Lakeshore Flood Statement'
    ],
    'Tropical': [
        'Hurricane Warning', 'Tropical Storm Warning',
        'Storm Surge Warning', 'Tsunami Warning'
    ],
    'Other': [
        'Extreme Wind Warning',
        'High Wind Warning', 'Wind Advisory', 'Brisk Wind Advisory',
        'Dust Storm Warning', 'Excessive Heat Warning', 'Heat Advisory',
        'Dense Fog Advisory',
        'Special Weather Statement (County)'
    ],
    'Watches': [
        'Tornado Watch', 'Severe Thunderstorm Watch',
        'Blizzard Watch', 'Winter Storm Watch', 'Lake Effect Snow Watch',
        'Wind Chill Watch', 'Freeze Watch', 'Hard Freeze Watch',
        'Fire Weather Watch',
        'Gale Watch', 'Storm Watch', 'Hazardous Seas Watch', 'Heavy Freezing Spray Watch',
        'Flash Flood Watch', 'Flood Watch', 'Coastal Flood Watch', 'Lakeshore Flood Watch',
        'Hurricane Watch', 'Tropical Storm Watch', 'Storm Surge Watch', 'Tsunami Watch',
        'High Wind Watch', 'Excessive Heat Watch'
    ]
};

const ALL_GRANULAR_EVENTS = (function () {
    const set = new Set();
    for (const events of Object.values(ALERT_TYPES_BY_CATEGORY)) {
        events.forEach((e) => set.add(e));
    }
    return set;
})();

function _load_saved_state() {
    if (_savedStateCache) return _savedStateCache;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                _savedStateCache = parsed;
                return _savedStateCache;
            }
        }
        const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacyRaw) {
            const parsedLegacy = JSON.parse(legacyRaw);
            if (parsedLegacy && typeof parsedLegacy === 'object') {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(parsedLegacy));
                _savedStateCache = parsedLegacy;
                return _savedStateCache;
            }
        }
    } catch (_) {}
    _savedStateCache = {};
    return _savedStateCache;
}

function _save_state(state) {
    _savedStateCache = Object.assign({}, state);
    _resolvedDisplayStateCache = null;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(_savedStateCache));
    } catch (_) {}
}

function _load_category_state() {
    if (_categoryStateCache) return _categoryStateCache;
    try {
        const raw = localStorage.getItem(CATEGORY_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                _categoryStateCache = parsed;
                return _categoryStateCache;
            }
        }
        const legacyRaw = localStorage.getItem(LEGACY_CATEGORY_STORAGE_KEY);
        if (legacyRaw) {
            const parsedLegacy = JSON.parse(legacyRaw);
            if (parsedLegacy && typeof parsedLegacy === 'object') {
                localStorage.setItem(CATEGORY_STORAGE_KEY, JSON.stringify(parsedLegacy));
                _categoryStateCache = parsedLegacy;
                return _categoryStateCache;
            }
        }
    } catch (_) {}
    _categoryStateCache = {};
    return _categoryStateCache;
}

function _save_category_state(state) {
    _categoryStateCache = Object.assign({}, state);
    try {
        localStorage.setItem(CATEGORY_STORAGE_KEY, JSON.stringify(_categoryStateCache));
    } catch (_) {}
}

function get_category_enabled(category) {
    const saved = _load_category_state();
    return saved.hasOwnProperty(category) ? saved[category] : true;
}

function set_category_master_enabled(category, enabled) {
    const saved = Object.assign({}, _load_category_state());
    saved[category] = !!enabled;
    _save_category_state(saved);
}

function _get_category_for_event(event) {
    for (const [category, events] of Object.entries(ALERT_TYPES_BY_CATEGORY)) {
        if (events.includes(event)) return category;
    }
    return null;
}

function get_display_state() {
    if (_resolvedDisplayStateCache) {
        return Object.assign({}, _resolvedDisplayStateCache);
    }
    const saved = _load_saved_state();
    const state = {};
    for (const events of Object.values(ALERT_TYPES_BY_CATEGORY)) {
        for (const event of events) {
            state[event] = saved.hasOwnProperty(event) ? saved[event] : true;
        }
    }
    _resolvedDisplayStateCache = state;
    return Object.assign({}, _resolvedDisplayStateCache);
}

const ALIAS_MAP = {
    'Tornado Emergency': 'Tornado Warning',
    'PDS Tornado Warning': 'Tornado Warning'
};

function get_alert_type_enabled(event) {
    const resolved = ALIAS_MAP[event] || event;
    const category = _get_category_for_event(resolved);
    if (category && !get_category_enabled(category)) return false;
    const state = get_display_state();
    return state.hasOwnProperty(resolved) ? state[resolved] : true;
}

function set_alert_type_enabled(event, enabled) {
    const state = get_display_state();
    state[event] = !!enabled;
    _save_state(state);
}

function set_category_enabled(category, enabled) {
    set_category_master_enabled(category, enabled);
}

function is_category_all_enabled(category) {
    const events = ALERT_TYPES_BY_CATEGORY[category];
    if (!events || events.length === 0) return true;
    const state = get_display_state();
    return events.every((e) => state[e]);
}

function is_category_any_enabled(category) {
    const events = ALERT_TYPES_BY_CATEGORY[category];
    if (!events || events.length === 0) return false;
    const state = get_display_state();
    return events.some((e) => state[e]);
}

function is_granular_event(event) {
    return ALL_GRANULAR_EVENTS.has(event);
}

const MD_STORAGE_KEY = 'stormTrackPro_mesoscale_enabled';
function get_mesoscale_enabled() {
    try {
        const v = localStorage.getItem(MD_STORAGE_KEY);
        if (v !== null) return v === 'true';
    } catch (_) {}
    return false;
}
function set_mesoscale_enabled(enabled) {
    try { localStorage.setItem(MD_STORAGE_KEY, String(!!enabled)); } catch (_) {}
}

function reset_to_defaults() {
    _savedStateCache = {};
    _categoryStateCache = {};
    _resolvedDisplayStateCache = null;
    try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(CATEGORY_STORAGE_KEY);
        localStorage.removeItem(MD_STORAGE_KEY);
    } catch (_) {}
}

module.exports = {
    get_display_state,
    get_alert_type_enabled,
    set_alert_type_enabled,
    set_category_enabled,
    get_category_enabled,
    is_category_all_enabled,
    is_category_any_enabled,
    is_granular_event,
    get_mesoscale_enabled,
    set_mesoscale_enabled,
    reset_to_defaults,
    ALERT_TYPES_BY_CATEGORY
};
