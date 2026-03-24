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
const loaders_nexrad = require('../radar/libnexrad/loaders_nexrad');
const radar_scan_animation = require('../radar/station_markers/radar_scan_animation');
const settings_store = require('../core/menu/settings_store');

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
    return (features || []).filter((f) => {
        const event = f?.properties?.event || '';
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

function _extract_storm_info(p) {
    const event = p.event || '';
    const params = p.parameters || {};
    const desc = (p.description || '').toUpperCase();
    const parts = [];

    if (event === 'Flash Flood Warning') {
        const threat = params.flashFloodDamageThreat;
        const source = params.flashFloodDetection;
        if (threat && Array.isArray(threat) && threat[0]) {
            parts.push(`Damage Threat: <span class="alertsDetailHighlight">${threat[0]}</span>`);
        }
        if (source && Array.isArray(source) && source[0]) {
            parts.push(`Source: ${source[0]}`);
        }
        return parts.length ? parts.join(' ') : null;
    }

    const isConvective = CONVECTIVE_EVENTS.includes(event);
    if (!isConvective) return null;

    const isTornadoWarning = ['Tornado Emergency', 'PDS Tornado Warning', 'Tornado Warning'].includes(event);

    if (isTornadoWarning) {
        const tornadoDet = params.tornadoDetection;
        if (tornadoDet && Array.isArray(tornadoDet) && tornadoDet[0]) {
            parts.push(`Tornado: <span class="alertsDetailHighlight">${tornadoDet[0]}</span>`);
        } else if (desc.includes('RADAR INDICATED') || desc.includes('RADAR-INDICATED')) {
            parts.push('Tornado: <span class="alertsDetailHighlight">RADAR INDICATED</span>');
        } else if (desc.includes('POSSIBLE TORNADO') || desc.includes('TORNADO POSSIBLE')) {
            parts.push('Tornado: <span class="alertsDetailHighlight">POSSIBLE</span>');
        }
    }

    const hail = params.maxHailSize;
    if (hail && Array.isArray(hail) && hail[0]) {
        const n = parseFloat(hail[0]);
        const hStr = (n === 0 || isNaN(n)) ? '0.00' : (n > 0 && n < 1 ? '<' + hail[0].replace(/^0\./, '.') : n.toFixed(2));
        parts.push(`Hail: ${hStr}IN`);
    } else {
        parts.push('Hail: 0.00IN');
    }

    const wind = params.maxWindGust;
    if (wind && Array.isArray(wind) && wind[0]) {
        parts.push(`Wind: <b>${wind[0]}</b>`);
    }

    return parts.length ? parts.join(' ') : null;
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
            headers.append('User-Agent', '(StormTrack Pro, https://stormtrack-pro.local)');
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
    window.stormTrackData.currentStation = station;
    $('#radarStation').html(station);
    const nexrad_locations = require('../radar/libnexrad/nexrad_locations').NEXRAD_LOCATIONS;
    const { get_station_state } = require('../radar/libnexrad/nexrad_locations');
    var alertLocName = nexrad_locations[station]?.name || '';
    var alertLocState = get_station_state(station);
    $('#radarLocation').html(alertLocState && alertLocName ? alertLocName + ', ' + alertLocState : alertLocName);
    $('#wsr88d_psm').show();
    $('#tdwr_psm').hide();
    $('#level2_psm').hide();
    $('#productsDropdownTriggerText').html(window.longProductNames?.['ref'] || 'Reflectivity');
    $('#radarInfoSpan').show();
    window.stormTrackData.from_file_upload = false;
    loaders_nexrad.quick_level_3_plot(station, 'N0B', () => {});
    var sweepEnabled = settings_store.load().radarSweep;
    if (sweepEnabled !== false) {
        radar_scan_animation.update(station);
    }
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
        const card = $('<div class="alertsCard"></div>');
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

        const body = $('<div class="alertsCardBody"></div>');

        items.forEach((f) => {
            const p = f.properties;
            const stormInfo = _extract_storm_info(p);
            const expiresStr = _format_expires(p);
            const pills = _get_location_pills(p);
            const displayPills = pills.length ? pills : ['Area Unknown'];
            const sender = p.senderName || p.sender || '';

            const detail = $(`
                <div class="alertsDetailCard" data-id="${f.id || ''}">
                    <div class="alertsDetailContent">
                        ${stormInfo ? `<div class="alertsDetailStorm">${stormInfo}</div>` : ''}
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
                    textColor: textColor
                });
            });

            detail.on('click', function (e) {
                if ($(e.target).closest('.alertsDetailBtn').length) return;
                const textColor = chroma(color).luminance() > 0.4 ? 'black' : 'white';
                display_app_dialog({
                    title: p.event,
                    body: alert_helpers.build_full_alert_body(p),
                    color: color,
                    textColor: textColor
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
}

module.exports = {
    open_panel,
    close_panel,
    toggle_panel,
    refresh_alerts_list,
    init
};
