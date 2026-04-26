/**
 * Alerts Display popup - 2-pane layout.
 * Left: info panel with alert hints + most dangerous active alert in the US.
 * Right: single-column collapsible category cards with toggles.
 */
const apply_alerts_display = require('./apply_visibility').apply_alerts_display;
const armFunctions = require('../core/menu/vortexRadarMenu');
const alerts_display_state = require('./alerts_display_state');
const get_polygon_colors = require('./colors/polygon_colors');

const CATEGORY_META = {
    'Severe Weather': { icon: 'fa-bolt-lightning', accent: '#e04040' },
    'Winter':         { icon: 'fa-snowflake',      accent: '#5b9bd5' },
    'Fire':           { icon: 'fa-fire',            accent: '#e88832' },
    'Marine':         { icon: 'fa-water',           accent: '#3cbfae' },
    'Flood':          { icon: 'fa-house-flood-water', accent: '#4caf50' },
    'Tropical':       { icon: 'fa-hurricane',       accent: '#c060d0' },
    'Other':          { icon: 'fa-triangle-exclamation', accent: '#aaa' },
    'Watches':        { icon: 'fa-eye',             accent: '#d4c85a' }
};

const ALERT_HINTS = {
    'Tornado Warning':            'A tornado has been sighted or indicated by radar. Take shelter immediately in an interior room on the lowest floor.',
    'Severe Thunderstorm Warning':'Storms producing 58+ mph winds and/or 1" hail. Move indoors and away from windows.',
    'Extreme Wind Warning':       'Sustained surface winds of 115+ mph. This is an extraordinarily rare and dangerous event.',
    'Flash Flood Warning':        'Rapid flooding of streams, creeks, or low-lying areas. Move to higher ground immediately. Turn around, don\'t drown.',
    'Special Marine Warning':     'Hazardous marine conditions including waterspouts, thunderstorms, or winds 34+ knots over water.',
    'Special Weather Statement':  'A storm-based advisory issued for active severe weather, using polygon geometry to track specific storms.',
    'Special Weather Statement (County)': 'A county-wide advisory highlighting general weather conditions that may cause concern but don\'t meet warning criteria.',
    'Mesoscale Discussion':       'SPC analysis of developing severe weather potential. Often a precursor to watches being issued.',
    'Marine Weather Statement':   'Information about ongoing or expected marine weather conditions not covered by other products.',
    'Blizzard Warning':           'Sustained winds or gusts of 35+ mph with considerable falling/blowing snow, reducing visibility to 1/4 mile or less for 3+ hours.',
    'Winter Storm Warning':       'Heavy snow (6"+), heavy sleet, or a dangerous combination of winter weather. Travel may be impossible.',
    'Lake Effect Snow Warning':   'Heavy lake-effect snow of 7"+ in 12 hours. Intense snowfall rates can create near-zero visibility.',
    'Snow Squall Warning':        'Brief but intense bursts of snow with gusty winds causing whiteout conditions. Very dangerous for travel.',
    'Ice Storm Warning':          'Ice accumulation of 1/4" or more expected. Extremely dangerous travel and widespread power outages likely.',
    'Winter Weather Advisory':    'Snow, sleet, freezing rain, or a mix expected. Travel will be difficult but not impossible.',
    'Freeze Warning':             'Sub-freezing temperatures are expected. Protect sensitive plants, pets, and exposed pipes.',
    'Frost Advisory':             'Temperatures are expected to support frost formation. Cover or bring in sensitive vegetation.',
    'Wind Chill Warning':         'Wind chill values of -25\u00b0F or lower. Frostbite can occur in as little as 10 minutes on exposed skin.',
    'Wind Chill Advisory':        'Wind chill values between -15\u00b0F and -24\u00b0F expected. Dress in layers if you must go outside.',
    'Avalanche Warning':          'An avalanche is expected or occurring. Avoid backcountry travel and avalanche-prone terrain immediately.',
    'Avalanche Advisory':         'Avalanche conditions are developing. Use caution in and near avalanche terrain and monitor forecasts closely.',
    'Avalanche Watch':            'Avalanche conditions are possible within 48 hours. Check avalanche forecasts before backcountry travel.',
    'Red Flag Warning':           'Critical fire weather conditions: low humidity, strong winds, and dry fuels. Fires can spread rapidly and be difficult to control.',
    'Fire Warning':               'A fire has been reported. Follow evacuation orders immediately and monitor local emergency channels.',
    'Extreme Fire Danger':        'Conditions are extremely favorable for wildfire ignition and rapid spread. Any fire start could become catastrophic.',
    'Gale Warning':               'Sustained winds of 34-47 knots over water. Small craft should not venture out.',
    'Storm Warning':              'Sustained winds of 48-63 knots over water. Very dangerous conditions for all vessels.',
    'Small Craft Advisory':       'Winds 18-33 knots and/or hazardous wave conditions. Inexperienced mariners should avoid navigating.',
    'Lake Wind Advisory':         'Strong winds of 25-35 mph over area lakes creating hazardous wave conditions for small craft and recreational boaters.',
    'Hazardous Seas Warning':     'Very high seas or dangerous wave conditions that can capsize or damage vessels.',
    'Heavy Freezing Spray Warning':'Heavy ice accumulation on vessels from freezing spray. Can affect stability and make decks treacherous.',
    'Flood Warning':              'Flooding is occurring or imminent. Move away from flood-prone areas. Do not walk or drive through floodwaters.',
    'Flood Advisory':             'Minor flooding expected. It may cause inconvenience but is not life-threatening if caution is exercised.',
    'Coastal Flood Warning':      'Significant flooding expected along the coast from tidal surge. Coastal roads and low areas may be impassable.',
    'Coastal Flood Advisory':     'Minor to moderate coastal flooding is expected. Low-lying roads and shoreline areas may briefly flood around high tide.',
    'Lakeshore Flood Warning':    'Significant flooding expected along lakeshores from high water and waves.',
    'Coastal Flood Statement':    'Follow-up information on an ongoing or recent coastal flooding event.',
    'Lakeshore Flood Statement':  'Follow-up information on an ongoing or recent lakeshore flooding event.',
    'Hurricane Warning':          'Hurricane conditions (74+ mph winds) expected within 36 hours. Complete storm preparations and evacuate if ordered.',
    'Tropical Storm Warning':     'Tropical storm conditions (39-73 mph winds) expected within 36 hours. Secure loose objects and prepare.',
    'Storm Surge Warning':        'Life-threatening storm surge flooding expected. This is often the greatest threat from a hurricane.',
    'Tsunami Warning':            'A tsunami is expected or occurring. Move to high ground immediately and stay away from the coast.',
    'High Wind Warning':          'Sustained winds of 40+ mph or gusts of 58+ mph. Secure outdoor objects and avoid unnecessary travel.',
    'Wind Advisory':              'Winds strong enough to make travel difficult are expected. Use caution, especially in high-profile vehicles.',
    'Brisk Wind Advisory':        'Persistent strong winds expected. Secure loose outdoor items and use extra travel caution.',
    'Dust Storm Warning':         'Visibility reduced to 1/4 mile or less from blowing dust. Pull off the road, turn off lights, and wait.',
    'Excessive Heat Warning':     'Dangerously hot conditions with temperatures and/or heat index values reaching 105\u00b0F+. Heat illness is likely.',
    'Heat Advisory':              'Heat index values up to 105\u00b0F. Drink plenty of fluids, stay in AC, and check on vulnerable neighbors.',
    'Rip Current Statement':      'Dangerous rip currents expected at area beaches. Stay out of the surf or swim near a lifeguard.',
    'Beach Hazards Statement':    'Hazardous conditions including high surf, rip currents, or sneaker waves at area beaches.',
    'Dense Fog Advisory':         'Visibility reduced to 1/4 mile or less from fog. Slow down and use low-beam headlights.',
    'Tornado Watch':              'Conditions are favorable for tornadoes. Stay alert and be ready to take shelter quickly.',
    'Severe Thunderstorm Watch':  'Conditions are favorable for severe storms with large hail and/or damaging winds.',
    'Blizzard Watch':             'Blizzard conditions possible within the next 48 hours. Prepare to shelter in place.',
    'Winter Storm Watch':         'Significant winter weather possible within 48 hours. Monitor forecasts and prepare.',
    'Lake Effect Snow Watch':     'Heavy lake-effect snow possible within 48 hours.',
    'Wind Chill Watch':           'Dangerously cold wind chill values possible. Prepare to limit time outdoors.',
    'Freeze Watch':               'Sub-freezing temperatures possible. Protect sensitive plants and exposed pipes.',
    'Hard Freeze Watch':          'Temperatures at or below 28\u00b0F possible, lasting several hours. May kill crops and damage unprotected pipes.',
    'Fire Weather Watch':         'Critical fire weather conditions possible within 72 hours.',
    'Gale Watch':                 'Gale-force winds (34-47 knots) possible over water within 48 hours.',
    'Storm Watch':                'Storm-force winds (48+ knots) possible over water within 48 hours.',
    'Hazardous Seas Watch':       'Hazardous sea conditions possible within 48 hours.',
    'Heavy Freezing Spray Watch': 'Heavy freezing spray possible on vessels within 48 hours.',
    'Flash Flood Watch':          'Conditions are favorable for flash flooding. Know your flood risk and be ready to move to higher ground.',
    'Flood Watch':                'Flooding is possible. Monitor forecasts and be prepared to move to higher ground.',
    'Coastal Flood Watch':        'Coastal flooding possible from tidal surge within 48 hours.',
    'Lakeshore Flood Watch':      'Lakeshore flooding possible from high water within 48 hours.',
    'Hurricane Watch':            'Hurricane conditions possible within 48 hours. Begin storm preparations.',
    'Tropical Storm Watch':       'Tropical storm conditions possible within 48 hours.',
    'Storm Surge Watch':          'Life-threatening storm surge possible within 48 hours. Know your evacuation zone.',
    'Tsunami Watch':              'A tsunami is possible. Stay alert for further information and be ready to move to high ground.',
    'High Wind Watch':            'High winds possible within 48 hours. Secure outdoor objects.',
    'Excessive Heat Watch':       'Dangerously hot conditions possible within 48 hours. Plan ahead to stay cool.'
};

const PRIORITY_ORDER = [
    'Tornado Emergency', 'PDS Tornado Warning', 'Tornado Warning',
    'Extreme Wind Warning', 'Hurricane Warning', 'Storm Surge Warning',
    'Tsunami Warning', 'Severe Thunderstorm Warning', 'Flash Flood Warning',
    'Blizzard Warning', 'Ice Storm Warning', 'Snow Squall Warning',
    'Hurricane Force Wind Warning', 'Tropical Storm Warning',
    'Storm Warning', 'Typhoon Warning', 'Fire Warning',
    'Special Marine Warning', 'Winter Storm Warning', 'Flood Warning',
    'Red Flag Warning', 'High Wind Warning', 'Dust Storm Warning',
    'Excessive Heat Warning', 'Gale Warning'
];

const COLLAPSE_KEY = 'vortexRadar_alerts_display_collapsed';
const LEGACY_COLLAPSE_KEY = 'vortexRadar_alerts_display_collapsed';

function _load_collapsed() {
    try {
        const r = localStorage.getItem(COLLAPSE_KEY);
        if (r) return JSON.parse(r);
        const legacy = localStorage.getItem(LEGACY_COLLAPSE_KEY);
        if (legacy) {
            localStorage.setItem(COLLAPSE_KEY, legacy);
            return JSON.parse(legacy);
        }
    } catch (_) {}
    return {};
}
function _save_collapsed(s) {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(s)); } catch (_) {}
}
function _is_collapsed(cat) { return !!_load_collapsed()[cat]; }
function _set_collapsed(cat, v) { const s = _load_collapsed(); s[cat] = v; _save_collapsed(s); }

function _color_dot(event) {
    const c = get_polygon_colors(event).color;
    return `<span class="adpDot" style="background:${c}"></span>`;
}

function _build_card(category, events) {
    const meta = CATEGORY_META[category] || { icon: 'fa-circle-exclamation', accent: '#888' };
    const catEnabled = alerts_display_state.get_category_enabled(category);
    const state = alerts_display_state.get_display_state();
    const catSafe = category.replace(/"/g, '&quot;');
    const masterChecked = catEnabled ? 'checked' : '';
    const bodyDisabled = catEnabled ? '' : ' adpCardBody-disabled';
    const collapsed = _is_collapsed(category);
    const collapsedClass = collapsed ? ' adpCard-collapsed' : '';
    const chevronClass = collapsed ? 'fa-chevron-right' : 'fa-chevron-down';

    let rows = '';
    for (const event of events) {
        const checked = state[event] ? 'checked' : '';
        const disabled = catEnabled ? '' : 'disabled';
        const evSafe = event.replace(/"/g, '&quot;');
        rows += `<label class="adpRow" data-event="${evSafe}">
            <span class="adpRowLabel">${_color_dot(event)}${event}</span>
            <div class="form-check form-switch adpRowSwitch">
                <input class="adpSwitch form-check-input" type="checkbox" role="switch"
                    data-event="${evSafe}" data-category="${catSafe}" ${checked} ${disabled}>
            </div>
        </label>`;
    }

    return `<div class="adpCard${collapsedClass}" data-category="${catSafe}">
        <div class="adpCardHeader" style="--adp-accent:${meta.accent}">
            <div class="adpCardHeaderLeft adpCollapseToggle">
                <i class="adpChevron fa-solid ${chevronClass}"></i>
                <i class="adpCardIcon fa-solid ${meta.icon}"></i>
                <span class="adpCardTitle">${category}</span>
                <span class="adpCardCount">${events.length}</span>
            </div>
            <div class="form-check form-switch adpMasterSwitchWrap">
                <input class="adpMasterSwitch form-check-input" type="checkbox" role="switch"
                    data-category="${catSafe}" ${masterChecked}>
            </div>
        </div>
        <div class="adpCardBody${bodyDisabled}" ${collapsed ? 'style="display:none"' : ''}>${rows}</div>
    </div>`;
}

function _build_info_panel() {
    return `<div class="adpInfo">
        <div class="adpInfoHint" id="adpInfoHint">
            <div class="adpInfoHintIcon"><i class="fa-solid fa-circle-info"></i></div>
            <div class="adpInfoHintTitle">Alert Info</div>
            <div class="adpInfoHintText">Hover over any alert type on the right to see a description of what it means and what action to take.</div>
        </div>
        <div class="adpInfoDanger" id="adpInfoDanger">
            <div class="adpInfoDangerHeader">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <span>Top Alert</span>
            </div>
            <div class="adpInfoDangerBody" id="adpInfoDangerBody">
                <div class="adpInfoDangerLoading"><i class="fa-solid fa-spinner"></i> Loading...</div>
            </div>
        </div>
    </div>`;
}

function _build_html() {
    let cards = '';
    for (const [category, events] of Object.entries(alerts_display_state.ALERT_TYPES_BY_CATEGORY)) {
        cards += _build_card(category, events);
    }

    const mdEnabled = alerts_display_state.get_mesoscale_enabled();
    const mdChecked = mdEnabled ? 'checked' : '';
    const mdActiveClass = mdEnabled ? ' adpBtnMd-active' : '';

    return `<div class="adpOverlay" id="adpOverlay">
        <div class="adpModal">
            <div class="adpHeader">
                <div class="adpHeaderLeft">
                    <span class="adpHeaderTitle">Alerts Display</span>
                    <span class="adpHeaderSub">Control which alerts appear on the map</span>
                </div>
                <div class="adpHeaderActions">
                    <button type="button" class="adpBtnAll adpBtnMd${mdActiveClass}" id="adpToggleMd">
                        <i class="fa-solid fa-circle"></i> Mesoscale
                    </button>
                    <button type="button" class="adpBtnAll" id="adpEnableAll">Enable All</button>
                    <button type="button" class="adpBtnAll adpBtnAllOff" id="adpDisableAll">Disable All</button>
                    <button type="button" class="adpCloseBtn" id="adpClose"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="adpContent">
                ${_build_info_panel()}
                <div class="adpToggleCol">${cards}</div>
            </div>
        </div>
    </div>`;
}

function _update_hint(event) {
    const hint = ALERT_HINTS[event];
    if (!hint) return;
    const color = get_polygon_colors(event).color;
    $('#adpInfoHintTitle').remove();
    const $hint = $('#adpInfoHint');
    $hint.find('.adpInfoHintIcon').css('color', color);
    $hint.find('.adpInfoHintTitle').text(event);
    $hint.find('.adpInfoHintText').text(hint);
}

function _reset_hint() {
    const $hint = $('#adpInfoHint');
    $hint.find('.adpInfoHintIcon').css('color', '#5b9bd5');
    $hint.find('.adpInfoHintTitle').text('Alert Info');
    $hint.find('.adpInfoHintText').text('Hover over any alert type on the right to see a description of what it means and what action to take.');
}

function _get_alert_priority(event) {
    const idx = PRIORITY_ORDER.indexOf(event);
    return idx >= 0 ? idx : 999;
}

function _fetch_most_dangerous() {
    const data = window.stormTrackData?.alerts_data;
    if (data && data.features && data.features.length > 0) {
        _render_danger_from_data(data);
        return;
    }
    const url = 'https://api.weather.gov/alerts/active?status=actual&message_type=alert&limit=500';
    const headers = new Headers();
    headers.append('User-Agent', '(Vortex Radar, https://vortexradar.snapsera.com)');
    headers.append('Accept', 'application/geo+json');
    fetch(url, { headers })
        .then(r => r.json())
        .then(d => _render_danger_from_data(d))
        .catch(() => {
            $('#adpInfoDangerBody').html('<div class="adpInfoDangerNone">Unable to fetch alerts</div>');
        });
}

function _render_danger_from_data(data) {
    if (!data || !data.features || data.features.length === 0) {
        $('#adpInfoDangerBody').html('<div class="adpInfoDangerNone">No active alerts in the US</div>');
        return;
    }

    let best = null;
    let bestPri = 9999;
    for (const f of data.features) {
        const ev = f.properties?.event;
        if (!ev) continue;
        const pri = _get_alert_priority(ev);
        if (pri < bestPri) {
            bestPri = pri;
            best = f;
        }
    }

    if (!best) {
        $('#adpInfoDangerBody').html('<div class="adpInfoDangerNone">No significant alerts active</div>');
        return;
    }

    const p = best.properties;
    const event = p.event || 'Unknown';
    const color = get_polygon_colors(event).color;
    const headline = p.headline || p.event || '';
    const areas = p.areaDesc || '';
    const sender = p.senderName || '';
    const expires = p.expires || p.ends || '';
    let expiresStr = '';
    if (expires) {
        try {
            const d = new Date(expires);
            expiresStr = d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        } catch (_) {}
    }

    const count = data.features.filter(f => f.properties?.event === event).length;

    const hint = ALERT_HINTS[event] || '';

    const html = `
        <div class="adpDangerAlert">
            <div class="adpDangerBadge" style="background:${color}; color:${_textColor(color)}">${event}</div>
            <div class="adpDangerCount">${count} active ${event}${count !== 1 ? 's' : ''} nationwide</div>
            ${headline ? `<div class="adpDangerHeadline">${headline}</div>` : ''}
            ${areas ? `<div class="adpDangerAreas"><i class="fa-solid fa-location-dot"></i> ${_truncate(areas, 120)}</div>` : ''}
            <div class="adpDangerMeta">
                ${sender ? `<span><i class="fa-solid fa-building"></i> ${sender}</span>` : ''}
                ${expiresStr ? `<span><i class="fa-solid fa-clock"></i> Until ${expiresStr}</span>` : ''}
            </div>
            ${hint ? `<div class="adpDangerHint"><i class="fa-solid fa-shield-halved"></i> ${hint}</div>` : ''}
        </div>`;
    $('#adpInfoDangerBody').html(html);
}

function _textColor(rgb) {
    try {
        const m = rgb.match(/\d+/g);
        if (m) {
            const lum = (parseInt(m[0]) * 299 + parseInt(m[1]) * 587 + parseInt(m[2]) * 114) / 1000;
            return lum > 140 ? '#000' : '#fff';
        }
    } catch (_) {}
    return '#fff';
}

function _truncate(str, max) {
    if (str.length <= max) return str;
    return str.substring(0, max) + '...';
}

function _bind(container) {
    const $c = $(container);

    // Close button should always close, even when clicking icon inside it.
    $c.find('#adpClose').on('click', function () {
        close_popup();
    });
    // Backdrop click closes only when clicking outside modal content.
    $c.find('#adpOverlay').on('click', function (e) {
        if (e.target === this) close_popup();
    });

    $c.find('.adpCollapseToggle').on('click', function (e) {
        if ($(e.target).closest('.adpMasterSwitchWrap').length) return;
        const card = $(this).closest('.adpCard');
        const category = card.data('category');
        const body = card.find('.adpCardBody');
        const chevron = card.find('.adpChevron');
        const isVisible = body.is(':visible');
        if (isVisible) {
            body.slideUp(150);
            chevron.removeClass('fa-chevron-down').addClass('fa-chevron-right');
            card.addClass('adpCard-collapsed');
        } else {
            body.slideDown(150);
            chevron.removeClass('fa-chevron-right').addClass('fa-chevron-down');
            card.removeClass('adpCard-collapsed');
        }
        _set_collapsed(category, isVisible);
    });

    $c.find('.adpMasterSwitch').on('change', function () {
        const category = $(this).data('category');
        const enabled = $(this).is(':checked');
        alerts_display_state.set_category_enabled(category, enabled);
        const card = $(this).closest('.adpCard');
        card.find('.adpCardBody').toggleClass('adpCardBody-disabled', !enabled);
        card.find('.adpSwitch').prop('disabled', !enabled);
        apply_alerts_display();
        $(document).trigger('alertsDataLoaded', [window.stormTrackData?.alerts_data]);
    });

    $c.find('.adpSwitch').on('change', function () {
        const event = $(this).data('event');
        const enabled = $(this).is(':checked');
        alerts_display_state.set_alert_type_enabled(event, enabled);
        apply_alerts_display();
        $(document).trigger('alertsDataLoaded', [window.stormTrackData?.alerts_data]);
    });

    $c.find('.adpRow').on('mouseenter', function () {
        const event = $(this).data('event');
        if (event) _update_hint(event);
    });
    $c.find('.adpRow').on('mouseleave', function () {
        _reset_hint();
    });

    $c.find('#adpToggleMd').on('click', function () {
        const current = alerts_display_state.get_mesoscale_enabled();
        alerts_display_state.set_mesoscale_enabled(!current);
        $(this).toggleClass('adpBtnMd-active', !current);
        apply_alerts_display();
    });

    $c.find('#adpEnableAll').on('click', function () {
        for (const category of Object.keys(alerts_display_state.ALERT_TYPES_BY_CATEGORY)) {
            alerts_display_state.set_category_enabled(category, true);
            const events = alerts_display_state.ALERT_TYPES_BY_CATEGORY[category];
            for (const event of events) alerts_display_state.set_alert_type_enabled(event, true);
        }
        _refresh_switches($c);
        apply_alerts_display();
        $(document).trigger('alertsDataLoaded', [window.stormTrackData?.alerts_data]);
    });

    $c.find('#adpDisableAll').on('click', function () {
        for (const category of Object.keys(alerts_display_state.ALERT_TYPES_BY_CATEGORY)) {
            alerts_display_state.set_category_enabled(category, false);
        }
        _refresh_switches($c);
        apply_alerts_display();
        $(document).trigger('alertsDataLoaded', [window.stormTrackData?.alerts_data]);
    });
}

function _refresh_switches($c) {
    const state = alerts_display_state.get_display_state();
    $c.find('.adpCard').each(function () {
        const category = $(this).data('category');
        const catEnabled = alerts_display_state.get_category_enabled(category);
        $(this).find('.adpMasterSwitch').prop('checked', catEnabled);
        $(this).find('.adpCardBody').toggleClass('adpCardBody-disabled', !catEnabled);
        $(this).find('.adpSwitch').each(function () {
            const ev = $(this).data('event');
            $(this).prop('checked', state[ev]);
            $(this).prop('disabled', !catEnabled);
        });
    });
}

function open_popup() {
    if ($('#adpOverlay').length) $('#adpOverlay').remove();
    $('body').append(_build_html());
    requestAnimationFrame(() => {
        $('#adpOverlay').addClass('adpOverlay-visible');
        _bind($('#adpOverlay').parent());
        _fetch_most_dangerous();
    });
}

function close_popup() {
    const $o = $('#adpOverlay');
    $o.removeClass('adpOverlay-visible');
    setTimeout(() => $o.remove(), 200);
}

function init() {
    $('#armrAlertsDisplayBtn').on('click', function () {
        armFunctions.hideARMwindow();
        open_popup();
    });
}

module.exports = { open_popup, close_popup, init };
