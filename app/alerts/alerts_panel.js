/**
 * Right-side alerts panel - RadarOmega-style layout.
 * Groups alerts by event type with nested detail cards, filter bar, and storm info.
 */
const fetch_data = require('./fetch_data');
const get_polygon_colors = require('./colors/polygon_colors');
const alerts_display_state = require('./alerts_display_state');
const { DateTime } = require('luxon');
const display_app_dialog = require('../core/menu/app_dialog');
const chroma = require('chroma-js');
const map = require('../core/map/map');
const turf = require('@turf/turf');
const alert_helpers = require('./alert_helpers');
const station_markers = require('../radar/station_markers/station_markers');

const PANEL_FILTER_ORDER = ['all', 'severe', 'tropical', 'winter', 'flood', 'fire', 'marine', 'watches', 'other'];
const CATEGORY_TO_FILTER = {
    'Severe Weather': 'severe',
    'Tropical': 'tropical',
    'Winter': 'winter',
    'Flood': 'flood',
    'Fire': 'fire',
    'Marine': 'marine',
    'Watches': 'watches',
    'Other': 'other'
};
const CATEGORY_SORT_ORDER = [
    'Severe Weather', 'Winter', 'Flood', 'Tropical', 'Fire', 'Marine', 'Watches', 'Other'
];
const ALIAS_EVENTS = {
    'Tornado Emergency': 'Tornado Warning',
    'PDS Tornado Warning': 'Tornado Warning'
};
const _zoneGeometryCache = new Map();
const _expandedGroups = new Set();
let _prevAlertCount = null;
let _headerAlertBannerEl = null;
let _headerAlertBannerTimeout = null;
let _headerAlertBannerFadeTimeout = null;
let _headerAlertBannerQueue = [];
let _headerAlertBannerShowing = false;
let _headerAlertBannerListener = null;
const _HEADER_ALERT_BANNER_MIN_MS = 10000;
const _HEADER_ALERT_BANNER_MAX_MS = 15000;
const _HEADER_ALERT_BANNER_EXIT_MS = 560;

function _resolve_event_category(event) {
    const resolvedEvent = ALIAS_EVENTS[event] || event;
    for (const [category, events] of Object.entries(alerts_display_state.ALERT_TYPES_BY_CATEGORY)) {
        if (events.includes(resolvedEvent)) return category;
    }
    if (resolvedEvent && (resolvedEvent.endsWith('Watch') || resolvedEvent.includes(' Watch'))) return 'Watches';
    if (resolvedEvent && resolvedEvent.includes('Flood')) return 'Flood';
    if (resolvedEvent && resolvedEvent.includes('Marine')) return 'Marine';
    return 'Other';
}

function _get_filter_category(event) {
    const category = _resolve_event_category(event);
    return CATEGORY_TO_FILTER[category] || 'other';
}

function _is_event_enabled(event) {
    if (!event) return false;
    if (alerts_display_state.is_granular_event(event)) {
        return alerts_display_state.get_alert_type_enabled(event);
    }
    const resolvedEvent = ALIAS_EVENTS[event] || event;
    const category = _resolve_event_category(resolvedEvent);
    return alerts_display_state.get_category_enabled(category);
}

function _is_watch_event(event) {
    return !!event && (event.endsWith('Watch') || event.includes(' Watch'));
}

function _filter_panel_features(features) {
    const seenKeys = new Set();
    return (features || []).filter((f) => {
        const event = f?.properties?.event || '';
        const props = f?.properties || {};
        const alertId = f?.id || props.id || '';
        const dedupeKey = alertId || [
            event,
            props.sent || '',
            props.onset || '',
            props.effective || '',
            props.expires || props.ends || '',
            props.areaDesc || '',
            props.sender || props.senderName || ''
        ].join('|');

        if (seenKeys.has(dedupeKey)) return false;
        seenKeys.add(dedupeKey);

        if (_is_watch_event(event)) return false;
        if (event === 'Special Weather Statement') {
            const toggleKey = f?.geometry
                ? 'Special Weather Statement'
                : 'Special Weather Statement (County)';
            return alerts_display_state.get_alert_type_enabled(toggleKey);
        }
        return _is_event_enabled(event);
    });
}

function _get_priority(event) {
    const gpc = get_polygon_colors(event);
    return parseInt(gpc.priority) || 999;
}

function _group_by_event(features) {
    const groups = {};
    features.forEach((f) => {
        const event = f.properties.event || 'Alert';
        if (!groups[event]) groups[event] = [];
        groups[event].push(f);
    });
    return groups;
}

const CONVECTIVE_EVENTS = [
    'Tornado Emergency', 'PDS Tornado Warning', 'Tornado Warning',
    'Severe Thunderstorm Warning', 'Severe Thunderstorm Watch', 'Tornado Watch'
];

function _get_first_param_value(params, key) {
    if (!params || !Object.prototype.hasOwnProperty.call(params, key)) return '';
    const val = params[key];
    if (Array.isArray(val)) return String(val[0] || '');
    return String(val || '');
}

function _get_nws_severe_threat_level(params) {
    const threat = (
        _get_first_param_value(params, 'thunderstormDamageThreat')
        || _get_first_param_value(params, 'damageThreat')
    ).trim().toUpperCase();
    if (threat === 'CONSIDERABLE' || threat === 'DESTRUCTIVE') return threat;
    return '';
}

function _get_nws_tornado_status(params) {
    const tornadoDamageThreat = _get_first_param_value(params, 'tornadoDamageThreat').trim().toUpperCase();
    const tornadoDetection = _get_first_param_value(params, 'tornadoDetection').trim().toUpperCase();
    const nwsHeadline = _get_first_param_value(params, 'NWSheadline').trim().toUpperCase();

    if (nwsHeadline.includes('TORNADO EMERGENCY') || tornadoDamageThreat === 'CATASTROPHIC') {
        return 'TORNADO EMERGENCY';
    }
    if (tornadoDamageThreat === 'CONSIDERABLE') {
        return 'PDS';
    }
    if (tornadoDetection.includes('OBSERVED')) {
        return 'OBSERVED';
    }
    if (tornadoDetection.includes('RADAR INDICATED')) {
        return 'RADAR INDICATED';
    }
    return '';
}

function _extract_storm_pills(p) {
    const event = p.event || '';
    const params = p.parameters || {};
    const pills = [];

    if (event === 'Flash Flood Warning') {
        const source = params.flashFloodDetection;
        if (source && Array.isArray(source) && source[0]) pills.push(source[0].toUpperCase());
        const threat = params.flashFloodDamageThreat;
        if (threat && Array.isArray(threat) && threat[0]) pills.push(threat[0].toUpperCase());
        return pills;
    }

    const isConvective = CONVECTIVE_EVENTS.includes(event);
    if (!isConvective) return pills;

    const isTornadoWarning = ['Tornado Emergency', 'PDS Tornado Warning', 'Tornado Warning'].includes(event);

    if (isTornadoWarning) {
        const tornadoStatus = _get_nws_tornado_status(params);
        if (tornadoStatus) pills.push(tornadoStatus);
    }

    if (event === 'Severe Thunderstorm Warning') {
        const severeThreat = _get_nws_severe_threat_level(params);
        if (severeThreat) pills.push(severeThreat);
    }

    const hail = params.maxHailSize;
    if (hail && Array.isArray(hail) && hail[0]) {
        const n = parseFloat(hail[0]);
        if (!isNaN(n) && n > 0) {
            const hStr = n < 1 ? '<' + hail[0].replace(/^0\./, '.') + '"' : n.toFixed(2) + '"';
            pills.push(hStr + ' HAIL');
        }
    }

    const wind = params.maxWindGust;
    if (wind && Array.isArray(wind) && wind[0]) pills.push(wind[0]);

    return pills;
}

function _get_storm_pill_class(pill) {
    const lowered = String(pill || '').toLowerCase();
    if (lowered.includes('observed') || lowered.includes('considerable') || lowered.includes('destructive') || lowered.includes('pds') || lowered.includes('emergency')) {
        return ' alertsDetailStormPill-critical';
    }
    if (lowered.includes('radar indicated')) {
        return ' alertsDetailStormPill-radar';
    }
    if (lowered.includes('possible')) {
        return ' alertsDetailStormPill-possible';
    }
    return '';
}

function _format_expires(p) {
    const expires = p.expires || p.ends;
    if (!expires) return '';
    const dt = DateTime.fromISO(expires);
    const diff = dt.diff(DateTime.now(), ['minutes']);
    const mins = Math.round(diff.minutes);
    if (mins < 0) return 'Expired';
    if (mins < 60) return `Expires in ... ${mins} mins.`;
    const hours = Math.floor(mins / 60);
    const remain = mins % 60;
    return `Expires in ... ${hours}h ${remain}m`;
}

function _get_state_abbrev(p) {
    const ugc = p.geocode?.UGC;
    if (ugc && ugc[0]) {
        return ugc[0].substring(0, 2);
    }
    return '';
}

function _is_state_token(token) {
    return /^[A-Z]{2}$/.test((token || '').trim());
}

function _parse_area_desc_parts(areaDesc) {
    if (!areaDesc) return [];
    const normalized = areaDesc.replace(/\s+/g, ' ').trim();
    if (!normalized) return [];

    if (normalized.includes(';')) {
        return normalized.split(';').map((s) => s.trim()).filter(Boolean);
    }

    const tokens = normalized.split(',').map((s) => s.trim()).filter(Boolean);
    const parts = [];
    for (let i = 0; i < tokens.length; i++) {
        const current = tokens[i];
        const next = tokens[i + 1];
        if (next && _is_state_token(next)) {
            parts.push(`${current}, ${next}`);
            i++;
            continue;
        }
        parts.push(current);
    }
    return parts;
}

function _get_location_pills(p) {
    const stateAbbrev = _get_state_abbrev(p);
    const areaParts = _parse_area_desc_parts(p.areaDesc);
    const deduped = [];
    const seen = new Set();

    for (const part of areaParts) {
        let label = part.trim();
        if (!label) continue;
        if (stateAbbrev && !/,\s*[A-Z]{2}$/.test(label)) {
            label = `${label}, ${stateAbbrev}`;
        }
        if (seen.has(label)) continue;
        seen.add(label);
        deduped.push(label);
    }

    return deduped.slice(0, 8);
}

function _normalize_zone_url(url) {
    if (!url || typeof url !== 'string') return null;
    return url.split('?')[0].replace(/\/+$/, '');
}

async function _fetch_zone_geometry(zoneUrl) {
    const normalized = _normalize_zone_url(zoneUrl);
    if (!normalized) return null;
    if (_zoneGeometryCache.has(normalized)) {
        return _zoneGeometryCache.get(normalized);
    }

    const fetchPromise = (async () => {
        try {
            const headers = new Headers();
            headers.append('User-Agent', '(Vortex Radar, https://vortexradar.snapsera.com)');
            headers.append('Accept', 'application/geo+json');
            const response = await fetch(normalized, { headers });
            if (!response.ok) return null;
            const data = await response.json();
            if (data?.type === 'Feature' && data.geometry) return data.geometry;
            if (data?.type === 'FeatureCollection' && Array.isArray(data.features) && data.features[0]?.geometry) {
                return data.features[0].geometry;
            }
            return null;
        } catch (_) {
            return null;
        }
    })();

    _zoneGeometryCache.set(normalized, fetchPromise);
    return fetchPromise;
}

async function _resolve_alert_geometry(feature) {
    if (feature?.geometry) return feature.geometry;
    const zones = feature?.properties?.affectedZones || [];
    const maxZonesToTry = 8;
    for (let i = 0; i < zones.length && i < maxZonesToTry; i++) {
        const geometry = await _fetch_zone_geometry(zones[i]);
        if (geometry) return geometry;
    }
    return null;
}

function _fly_to_geometry(geom) {
    if (!geom) return;
    try {
        const bbox = turf.bbox(geom);
        map.fitBounds(bbox, { padding: 40, maxZoom: 8, duration: 800 });
    } catch (_) {}
}

async function _select_radar_and_fly(feature) {
    const geom = await _resolve_alert_geometry(feature);
    if (!geom) return false;
    const centroid = turf.centroid(geom);
    const [lng, lat] = centroid.geometry.coordinates;
    const station = alert_helpers.get_best_wsr88d_radar(geom, lng, lat);
    if (!station) {
        _fly_to_geometry(geom);
        return true;
    }
    const nexrad_locations = require('../radar/libnexrad/nexrad_locations').NEXRAD_LOCATIONS;
    const stationType = nexrad_locations[station]?.type || 'WSR-88D';
    station_markers.selectStation(station, stationType);
    _fly_to_geometry(geom);
    return true;
}

function _render_alerts_list(features) {
    const list = $('#alertsPanelList');
    list.empty();
    const mode = window.stormTrackData?.alertsViewMode || 'overview';
    let activeFilter = window.stormTrackData?.alertsFilter || 'all';
    if (!PANEL_FILTER_ORDER.includes(activeFilter)) activeFilter = 'all';

    let filtered = mode === 'usa'
        ? features.slice()
        : (activeFilter === 'all'
            ? features.slice()
            : features.filter((f) => _get_filter_category(f.properties.event) === activeFilter));

    if (mode !== 'usa' && filtered.length === 0) {
        for (const cat of PANEL_FILTER_ORDER) {
            if (cat === 'all') continue;
            filtered = features.filter((f) => _get_filter_category(f.properties.event) === cat);
            if (filtered.length > 0) {
                activeFilter = cat;
                window.stormTrackData = window.stormTrackData || {};
                window.stormTrackData.alertsFilter = cat;
                $('.alertsFilterBtn').removeClass('alertsFilterBtn-active');
                $(`.alertsFilterBtn[data-filter="${cat}"]`).addClass('alertsFilterBtn-active');
                break;
            }
        }
    }

    $('#alertsPanel').toggleClass('alertsPanel-usaMode', mode === 'usa');
    list.toggleClass('alertsPanelList-usa', mode === 'usa');

    if (!filtered || filtered.length === 0) {
        list.html('<div class="alertsPanelEmpty">No active alerts in this category</div>');
        return;
    }

    const groups = _group_by_event(filtered);
    const eventOrder = Object.keys(groups).sort((a, b) => {
        const catA = CATEGORY_SORT_ORDER.indexOf(_resolve_event_category(a));
        const catB = CATEGORY_SORT_ORDER.indexOf(_resolve_event_category(b));
        const cA = catA >= 0 ? catA : 999;
        const cB = catB >= 0 ? catB : 999;
        if (cA !== cB) return cA - cB;
        return _get_priority(a) - _get_priority(b);
    });

    eventOrder.forEach((event) => {
        const items = groups[event].sort((a, b) => {
            const sentA = new Date(a.properties.sent || 0).getTime();
            const sentB = new Date(b.properties.sent || 0).getTime();
            return sentB - sentA;
        });
        const color = get_polygon_colors(event).color;
        const hexColor = chroma(color).hex();

        const isCollapsed = !_expandedGroups.has(event);
        const card = $(`<div class="alertsCard" style="--alert-accent:${hexColor}"></div>`);
        if (isCollapsed) card.addClass('alertsCard-collapsed');
        const header = $(`
            <div class="alertsCardHeader alertsCardHeader-clickable">
                <span class="alertsCardIcon" style="color: ${hexColor}"><span class="fa fa-triangle-exclamation"></span></span>
                <span class="alertsCardEvent">${event.toUpperCase()}</span>
                <span class="alertsCardBadge" style="background: ${hexColor}">${items.length}</span>
                <span class="alertsCardChevron fa fa-chevron-down"></span>
            </div>
        `);
        header.on('click', function () {
            const isNowCollapsed = card.hasClass('alertsCard-collapsed');
            if (isNowCollapsed) {
                _expandedGroups.add(event);
                card.removeClass('alertsCard-collapsed');
            } else {
                _expandedGroups.delete(event);
                card.addClass('alertsCard-collapsed');
            }
        });
        card.append(header);
        card.append('<div class="alertsCardDivider"></div>');

        const body = $('<div class="alertsCardBody"></div>');

        items.forEach((f) => {
            const p = f.properties;
            const stormPills = _extract_storm_pills(p);
            const expiresStr = _format_expires(p);
            const pills = _get_location_pills(p);
            const displayPills = pills.length ? pills : ['Area Unknown'];
            const sender = p.senderName || p.sender || '';

            const detail = $(`
                <div class="alertsDetailCard" data-id="${f.id || ''}">
                    <div class="alertsDetailContent">
                        ${stormPills.length ? `<div class="alertsDetailPills">${stormPills.map((pill) => `<span class="alertsDetailStormPill${_get_storm_pill_class(pill)}">${pill}</span>`).join('')}</div>` : ''}
                        ${expiresStr ? `<div class="alertsDetailExpires"><span class="alertsDetailDot" style="background: ${hexColor}"></span>${expiresStr}</div>` : ''}
                        ${sender ? `<div class="alertsDetailSender">${sender}</div>` : ''}
                        <div class="alertsDetailArea">
                            ${displayPills.map((pill) => `<span class="alertsDetailPill">${pill}</span>`).join('')}
                        </div>
                    </div>
                    <div class="alertsDetailActions">
                        <button type="button" class="alertsDetailBtn alertsDetailGlobe" title="Select radar and view on map"><span class="fa fa-globe"></span></button>
                        <button type="button" class="alertsDetailBtn alertsDetailArrow" title="View full details"><span class="fa fa-chevron-right"></span></button>
                    </div>
                </div>
            `);

            detail.find('.alertsDetailGlobe').on('click', async (e) => {
                e.stopPropagation();
                const btn = $(e.currentTarget);
                if (btn.prop('disabled')) return;
                btn.prop('disabled', true).addClass('alertsDetailBtn-loading');
                const success = await _select_radar_and_fly(f);
                if (success) close_panel();
                btn.prop('disabled', false).removeClass('alertsDetailBtn-loading');
            });

            detail.find('.alertsDetailArrow').on('click', (e) => {
                e.stopPropagation();
                const textColor = chroma(color).luminance() > 0.4 ? 'black' : 'white';
                display_app_dialog({
                    title: p.event,
                    body: alert_helpers.build_full_alert_body(p),
                    color: color,
                    textColor: textColor,
                    noBackdropBlur: true,
                    draggable: true,
                    allowBackgroundInteraction: true
                });
            });

            detail.on('click', function (e) {
                if ($(e.target).closest('.alertsDetailBtn').length) return;
                const textColor = chroma(color).luminance() > 0.4 ? 'black' : 'white';
                display_app_dialog({
                    title: p.event,
                    body: alert_helpers.build_full_alert_body(p),
                    color: color,
                    textColor: textColor,
                    noBackdropBlur: true,
                    draggable: true,
                    allowBackgroundInteraction: true
                });
            });

            body.append(detail);
        });

        card.append(body);
        list.append(card);
    });
}

function _update_filter_counts(features) {
    const counts = { all: features.length, severe: 0, tropical: 0, winter: 0, flood: 0, fire: 0, marine: 0, watches: 0, other: 0 };
    (features || []).forEach((f) => {
        const cat = _get_filter_category(f.properties.event);
        if (counts[cat] !== undefined) counts[cat]++;
    });
    $('.alertsFilterBtn').each(function () {
        const filter = $(this).data('filter');
        const count = counts[filter] || 0;
        $(this).find('.alertsFilterCount').text(count);
        $(this).toggleClass('alertsFilterBtn-active', filter === (window.stormTrackData?.alertsFilter || 'all'));
    });
}

function _update_panel_stats(features) {
    const total = (features || []).length;
    const highest = _get_highest_priority_alert(features || []);
    $('#alertsPanelTotalCount').text(total);
    $('#alertsPanelHighestThreat').text(highest?.properties?.event || 'None');
}

function open_panel() {
    $('#alertsPanel').removeClass('alertsPanel-closed').addClass('alertsPanel-open');
    $('#alertMenuItemIcon').addClass('menu_item_selected').removeClass('menu_item_not_selected');
    $('#floatingToolbar').css('right', '372px');
}

function close_panel() {
    $('#alertsPanel').removeClass('alertsPanel-open').addClass('alertsPanel-closed');
    $('#alertMenuItemIcon').removeClass('menu_item_selected').addClass('menu_item_not_selected');
    $('#floatingToolbar').css('right', '12px');
}

function toggle_panel() {
    $('#alertsPanel').toggleClass('alertsPanel-closed alertsPanel-open');
    var isOpen = $('#alertsPanel').hasClass('alertsPanel-open');
    $('#floatingToolbar').css('right', isOpen ? '372px' : '12px');
}

function refresh_alerts_list() {
    const data = window.stormTrackData?.alerts_data;
    if (data && data.features) {
        const panelFeatures = _filter_panel_features(data.features);
        _update_filter_counts(panelFeatures);
        _update_panel_stats(panelFeatures);
        _render_alerts_list(panelFeatures);
    } else {
        $('#alertsPanelList').html('<div class="alertsPanelEmpty">Loading alerts...</div>');
        fetch_data.return_data((alerts_data) => {
            const panelFeatures = _filter_panel_features(alerts_data?.features || []);
            _update_filter_counts(panelFeatures);
            _update_panel_stats(panelFeatures);
            _render_alerts_list(panelFeatures);
        });
    }
}

function _get_highest_priority_alert(features) {
    if (!features || features.length === 0) return null;
    let best = features[0];
    let bestPriority = _get_priority(best.properties.event);
    for (let i = 1; i < features.length; i++) {
        const p = _get_priority(features[i].properties.event);
        if (p < bestPriority) {
            best = features[i];
            bestPriority = p;
        }
    }
    return best;
}

function _trigger_header_sweep() {
    var sweep = document.getElementById('headerSweep');
    if (!sweep) {
        sweep = document.createElement('div');
        sweep.id = 'headerSweep';
        sweep.className = 'headerSweep';
        var hdr = document.getElementById('radarHeader');
        if (hdr) hdr.appendChild(sweep);
    }
    sweep.classList.remove('headerSweep-active');
    void sweep.offsetWidth;
    sweep.classList.add('headerSweep-active');
}

function _set_header_clock_suppressed(suppressed) {
    const $clock = $('#headerClock');
    if (!$clock.length) return;
    $clock.toggleClass('headerClock-hidden', !!suppressed);
}

function _ensure_header_alert_banner_el() {
    if (_headerAlertBannerEl) return;
    _headerAlertBannerEl = document.createElement('div');
    _headerAlertBannerEl.className = 'lmAlertBanner';
    const host = document.getElementById('top-right');
    (host || document.body).appendChild(_headerAlertBannerEl);
}

function _position_header_alert_banner() {
    if (!_headerAlertBannerEl) return;
    const host = document.getElementById('top-right');
    const btn = document.getElementById('alertsCountBtn');
    if (!btn) return;
    if (host) {
        if (_headerAlertBannerEl.parentElement !== host) host.appendChild(_headerAlertBannerEl);
        const tuckUnderPx = Math.round(Math.min(btn.offsetWidth * 0.28, 14));
        const gapPx = 0;
        const btnRect = btn.getBoundingClientRect();
        const maxBannerWidthPx = Math.max(140, Math.floor(btnRect.left + tuckUnderPx - 12));
        const safeRightTextInsetPx = tuckUnderPx + 6;
        _headerAlertBannerEl.style.top = btn.offsetTop + 'px';
        _headerAlertBannerEl.style.height = btn.offsetHeight + 'px';
        _headerAlertBannerEl.style.right = Math.max(0, (host.clientWidth - btn.offsetLeft) - tuckUnderPx + gapPx) + 'px';
        _headerAlertBannerEl.style.maxWidth = maxBannerWidthPx + 'px';
        _headerAlertBannerEl.style.setProperty('--lmAlertBannerSafeRight', safeRightTextInsetPx + 'px');
        return;
    }

    const rect = btn.getBoundingClientRect();
    const fallbackTuckUnderPx = Math.round(Math.min(rect.width * 0.28, 14));
    const fallbackGapPx = 0;
    const fallbackLeftSpacePx = Math.max(140, Math.floor(rect.left - 12 + fallbackTuckUnderPx - fallbackGapPx));
    const fallbackMaxWidthPx = fallbackLeftSpacePx;
    const fallbackSafeRightTextInsetPx = fallbackTuckUnderPx + 6;
    _headerAlertBannerEl.style.top = rect.top + 'px';
    _headerAlertBannerEl.style.height = rect.height + 'px';
    _headerAlertBannerEl.style.right = Math.max(0, (window.innerWidth - rect.left) - fallbackTuckUnderPx + fallbackGapPx) + 'px';
    _headerAlertBannerEl.style.maxWidth = fallbackMaxWidthPx + 'px';
    _headerAlertBannerEl.style.setProperty('--lmAlertBannerSafeRight', fallbackSafeRightTextInsetPx + 'px');
}

function _format_header_alert_banner_locations(states) {
    if (!Array.isArray(states) || states.length === 0) return '';
    const clean = states
        .map((s) => (s == null ? '' : String(s)).trim())
        .filter((s) => s.length > 0);
    if (!clean.length) return '';
    if (clean.length === 1) return clean[0];
    if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
    return `${clean.slice(0, -1).join(', ')}, and ${clean[clean.length - 1]}`;
}

function _show_header_alert_banner(eventName, states) {
    _ensure_header_alert_banner_el();
    const colorInfo = get_polygon_colors(eventName);
    const bgColor = colorInfo ? colorInfo.color : 'rgb(255, 0, 255)';

    let text = `New ${eventName}`;
    const locationList = _format_header_alert_banner_locations(states);
    if (locationList) text += ` in ${locationList}`;

    _headerAlertBannerEl.innerHTML =
        '<i class="lmAlertBannerIcon fa-solid fa-triangle-exclamation" aria-hidden="true"></i>' +
        `<span class="lmAlertBannerText">${$('<div>').text(text).html()}</span>`;
    _headerAlertBannerEl.style.background = bgColor;
    _headerAlertBannerEl.style.color = '#000';

    _position_header_alert_banner();
    _headerAlertBannerEl.classList.remove('lmAlertBanner-visible', 'lmAlertBanner-closing');
    void _headerAlertBannerEl.offsetWidth;
    _headerAlertBannerEl.classList.add('lmAlertBanner-visible');
    _headerAlertBannerShowing = true;
    _set_header_clock_suppressed(true);

    if (_headerAlertBannerTimeout) clearTimeout(_headerAlertBannerTimeout);
    if (_headerAlertBannerFadeTimeout) clearTimeout(_headerAlertBannerFadeTimeout);
    const visibleMs = _HEADER_ALERT_BANNER_MIN_MS + Math.floor(Math.random() * ((_HEADER_ALERT_BANNER_MAX_MS - _HEADER_ALERT_BANNER_MIN_MS) + 1));

    _headerAlertBannerTimeout = setTimeout(function () {
        if (!_headerAlertBannerEl) return;
        _headerAlertBannerEl.classList.remove('lmAlertBanner-visible');
        _headerAlertBannerEl.classList.add('lmAlertBanner-closing');
        _headerAlertBannerFadeTimeout = setTimeout(function () {
            if (_headerAlertBannerEl) _headerAlertBannerEl.classList.remove('lmAlertBanner-visible', 'lmAlertBanner-closing');
            _headerAlertBannerShowing = false;
            _set_header_clock_suppressed(false);
            _drain_header_alert_banner_queue();
        }, _HEADER_ALERT_BANNER_EXIT_MS);
    }, visibleMs);
}

function _drain_header_alert_banner_queue() {
    if (_headerAlertBannerShowing) return;
    if (_headerAlertBannerQueue.length === 0) return;
    const next = _headerAlertBannerQueue.shift();
    _show_header_alert_banner(next.event, next.states);
}

function _hide_header_alert_banner() {
    _headerAlertBannerQueue = [];
    _headerAlertBannerShowing = false;
    if (_headerAlertBannerTimeout) { clearTimeout(_headerAlertBannerTimeout); _headerAlertBannerTimeout = null; }
    if (_headerAlertBannerFadeTimeout) { clearTimeout(_headerAlertBannerFadeTimeout); _headerAlertBannerFadeTimeout = null; }
    if (_headerAlertBannerEl) {
        _headerAlertBannerEl.classList.remove('lmAlertBanner-visible', 'lmAlertBanner-closing');
    }
    _set_header_clock_suppressed(false);
}

function _enable_header_alert_banner() {
    if (_headerAlertBannerListener) return;
    _headerAlertBannerListener = function (e) {
        if (window?.stormTrackData?.liveModeActive) return;
        const detail = e?.detail;
        if (!detail || detail.type !== 'new') return;
        const eventName = detail.event || '';
        if (!eventName) return;
        if (!_is_event_enabled(eventName)) return;
        const states = detail.states || [];
        if (_headerAlertBannerShowing) {
            _headerAlertBannerQueue.push({ event: eventName, states: states });
        } else {
            _show_header_alert_banner(eventName, states);
        }
    };
    window.addEventListener('alertNotification', _headerAlertBannerListener);
    window.addEventListener('resize', _position_header_alert_banner);
}

function update_alerts_count_btn() {
    const btn = $('#alertsCountBtn');
    const data = window.stormTrackData?.alerts_data;
    const features = _filter_panel_features(data?.features || []);
    const count = features.length;
    btn.html(`
        <span class="alertsCountBtnText">
            <span class="alertsCountBtnNumber">${count}</span>
            <span class="alertsCountBtnLabel">Alert${count === 1 ? '' : 's'}</span>
        </span>
    `);

    if (_prevAlertCount !== null && count !== _prevAlertCount) {
        _trigger_header_sweep();
    }
    _prevAlertCount = count;

    if (count === 0) {
        btn.removeAttr('style').addClass('alertsCountBtn-empty');
        $('#radarHeader').css('--header-highest-alert-color', '#999');
        return;
    }

    btn.removeClass('alertsCountBtn-empty');
    const highest = _get_highest_priority_alert(features);
    const color = highest ? get_polygon_colors(highest.properties.event).color : 'rgb(255, 0, 255)';
    const chromaColor = chroma(color);
    const glowRgba = chromaColor.alpha(0.42).css('rgba');
    const traceColor = chromaColor.brighten(0.35).saturate(0.4).hex();
    const traceTail = chromaColor.darken(0.2).alpha(0.2).css('rgba');
    const textColor = '#000';
    $('#radarHeader').css('--header-highest-alert-color', color);
    btn.css({
        '--alerts-btn-accent': color,
        '--alerts-btn-trace': traceColor,
        '--alerts-btn-trace-tail': traceTail,
        background: color,
        color: textColor,
        boxShadow: `0 10px 24px -14px ${glowRgba}`
    });
}

function init() {
    $('#alertsPanelClose').on('click', close_panel);

    $('#alertsCountBtn').on('click', function () {
        refresh_alerts_list();
        toggle_panel();
        const isOpen = $('#alertsPanel').hasClass('alertsPanel-open');
        if (isOpen) {
            $('#alertMenuItemIcon').addClass('menu_item_selected').removeClass('menu_item_not_selected');
        } else {
            $('#alertMenuItemIcon').removeClass('menu_item_selected').addClass('menu_item_not_selected');
        }
    });

    window.stormTrackData = window.stormTrackData || {};
    window.stormTrackData.alertsFilter = window.stormTrackData.alertsFilter || 'all';
    window.stormTrackData.alertsViewMode = window.stormTrackData.alertsViewMode || 'overview';

    $('.alertsHeaderBtn').removeClass('alertsHeaderBtn-active');
    $(`.alertsHeaderBtn[data-mode="${window.stormTrackData.alertsViewMode}"]`).addClass('alertsHeaderBtn-active');
    $('.alertsHeaderBtn').on('click', function () {
        $(this).siblings().removeClass('alertsHeaderBtn-active');
        $(this).addClass('alertsHeaderBtn-active');
        window.stormTrackData.alertsViewMode = $(this).data('mode') || 'overview';
        refresh_alerts_list();
    });

    $('.alertsFilterBtn').on('click', function () {
        const filter = $(this).data('filter');
        window.stormTrackData = window.stormTrackData || {};
        window.stormTrackData.alertsFilter = filter;
        $(this).siblings().removeClass('alertsFilterBtn-active');
        $(this).addClass('alertsFilterBtn-active');
        refresh_alerts_list();
    });

    update_alerts_count_btn();

    $(document).on('alertsDataLoaded', function (e, alerts_data) {
        update_alerts_count_btn();
        if (alerts_data && alerts_data.features) {
            const panelFeatures = _filter_panel_features(alerts_data.features);
            _update_filter_counts(panelFeatures);
            _update_panel_stats(panelFeatures);
            if ($('#alertsPanel').hasClass('alertsPanel-open')) {
                _render_alerts_list(panelFeatures);
            }
        }
    });

    _enable_header_alert_banner();
}

module.exports = {
    open_panel,
    close_panel,
    toggle_panel,
    refresh_alerts_list,
    init
};
