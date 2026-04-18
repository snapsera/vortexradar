const alerts_display_state = require('./alerts_display_state');

const warnings_whitelist = [
    'Tornado Emergency', 'PDS Tornado Warning', 'Tornado Warning',
    'Severe Thunderstorm Warning', 'Flash Flood Warning', 'Special Marine Warning',
    'Snow Squall Warning', 'Extreme Wind Warning', 'Blizzard Warning', 'Winter Storm Warning',
    'Lake Effect Snow Warning', 'Ice Storm Warning', 'Winter Weather Advisory',
    'Red Flag Warning', 'Fire Warning', 'Gale Warning', 'Storm Warning',
    'Hurricane Warning', 'Tropical Storm Warning', 'Storm Surge Warning',
    'Flood Warning', 'Coastal Flood Warning', 'Lakeshore Flood Warning',
    'High Wind Warning', 'Dust Storm Warning', 'Excessive Heat Warning'
];
const watches_whitelist = [
    'Tornado Watch', 'Severe Thunderstorm Watch', 'Blizzard Watch', 'Winter Storm Watch',
    'Lake Effect Snow Watch', 'Fire Weather Watch', 'Gale Watch', 'Storm Watch',
    'Hurricane Watch', 'Tropical Storm Watch', 'Storm Surge Watch',
    'Flash Flood Watch', 'Flood Watch', 'High Wind Watch', 'Coastal Flood Watch',
    'Lakeshore Flood Watch', 'Excessive Heat Watch', 'Wind Chill Watch', 'Extreme Cold Watch',
    'Hard Freeze Watch', 'Freeze Watch', 'Avalanche Watch', 'Hazardous Seas Watch',
    'Heavy Freezing Spray Watch', 'Tsunami Watch', 'Storm Watch'
];
const statements_whitelist = ['Special Weather Statement'];

const _SWS_SEVERE_KEYWORDS = [
    'thunderstorm', 'severe', 'hail', 'tornado', 'funnel',
    'waterspout', 'rotating', 'supercell', 'mesocyclone',
    'damaging wind', 'wind damage', 'squall line',
    'wall cloud', 'lightning'
];

function _is_severe_sws(feature) {
    const props = feature?.properties || {};
    if (props._zone_expanded) return false;
    const params = props.parameters || {};
    const nwsHeadline = Array.isArray(params.NWSheadline)
        ? params.NWSheadline.join(' ')
        : (params.NWSheadline || '');
    const text = [nwsHeadline, props.headline || '', props.description || '']
        .join(' ').toLowerCase();
    return _SWS_SEVERE_KEYWORDS.some(kw => text.includes(kw));
}

function _is_warning(event) {
    return event.endsWith('Warning') || warnings_whitelist.includes(event);
}
function _is_watch(event) {
    return event.endsWith('Watch') || watches_whitelist.includes(event);
}
function _is_statement(event) {
    return statements_whitelist.includes(event);
}
function is_severe_or_statement(event) {
    return _is_warning(event) || _is_statement(event);
}

function _should_show_feature(feature) {
    const event = feature?.properties?.event || '';
    const has_geometry = feature?.geometry != null;
    if (!has_geometry) return false;

    if (event === 'Special Weather Statement') {
        if (_is_severe_sws(feature)) {
            if (!alerts_display_state.get_alert_type_enabled('Special Weather Statement')) return false;
        } else {
            if (!alerts_display_state.get_alert_type_enabled('Special Weather Statement (County)')) return false;
        }
        return true;
    }

    if (alerts_display_state.is_granular_event(event) && !alerts_display_state.get_alert_type_enabled(event)) {
        return false;
    }
    return true;
}

function filter_alerts(alerts_data) {
    alerts_data.features = alerts_data.features.filter((feature) => _should_show_feature(feature));
    return alerts_data;
}

module.exports = filter_alerts;
module.exports.is_severe_or_statement = is_severe_or_statement;
module.exports._is_warning = _is_warning;
module.exports._is_watch = _is_watch;
module.exports._is_statement = _is_statement;
module.exports.should_show_alert_feature = function (feature) {
    return _should_show_feature(feature);
};
module.exports.is_severe_sws_feature = function (feature) {
    return _is_severe_sws(feature);
};