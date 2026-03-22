var get_polygon_colors = require('../alerts/colors/polygon_colors');
var alert_voice = require('./alert_voice');

var _queue = [];
var _playing = false;
var _shownIds = new Set();
var MAX_LOOPS = 2;
var PIXELS_PER_SEC = 110;
var SLIDE_MS = 400;
var TRACER_MS = 600;
var _phaseTimer = null;

var STATE_TO_TZ = {
    AL: 'America/Chicago', AR: 'America/Chicago', IL: 'America/Chicago', IA: 'America/Chicago',
    KS: 'America/Chicago', LA: 'America/Chicago', MN: 'America/Chicago', MS: 'America/Chicago',
    MO: 'America/Chicago', NE: 'America/Chicago', OK: 'America/Chicago', SD: 'America/Chicago',
    TN: 'America/Chicago', TX: 'America/Chicago', WI: 'America/Chicago', KY: 'America/Kentucky/Louisville',
    IN: 'America/Indiana/Indianapolis', ND: 'America/Chicago', SC: 'America/New_York',
    CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', GA: 'America/New_York',
    ME: 'America/New_York', MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit',
    NC: 'America/New_York', NH: 'America/New_York', NJ: 'America/New_York', NY: 'America/New_York',
    OH: 'America/New_York', PA: 'America/New_York', RI: 'America/New_York', VT: 'America/New_York',
    VA: 'America/New_York', WV: 'America/New_York', FL: 'America/New_York',
    AZ: 'America/Phoenix', CO: 'America/Denver', ID: 'America/Boise', MT: 'America/Denver',
    NM: 'America/Denver', UT: 'America/Denver', WY: 'America/Denver',
    CA: 'America/Los_Angeles', NV: 'America/Los_Angeles', OR: 'America/Los_Angeles', WA: 'America/Los_Angeles',
    AK: 'America/Anchorage', HI: 'Pacific/Honolulu',
    PR: 'America/Puerto_Rico', VI: 'America/Virgin', GU: 'Pacific/Guam', AS: 'Pacific/Pago_Pago',
    MP: 'Pacific/Guam'
};

function _arr(val) {
    if (Array.isArray(val) && val[0]) return val[0];
    if (typeof val === 'string') return val;
    return null;
}

function _format_until(expires, properties) {
    if (!expires) return '';
    var { DateTime } = require('luxon');
    var dt = DateTime.fromISO(expires);
    if (!dt.isValid) return '';

    var ugc = properties?.geocode?.UGC;
    var code = ugc ? (Array.isArray(ugc) ? ugc[0] : ugc) : null;
    var state = code ? code.substring(0, 2).toUpperCase() : null;
    var ianaTz = state && STATE_TO_TZ[state] ? STATE_TO_TZ[state] : null;
    if (ianaTz) dt = dt.setZone(ianaTz);

    var tzShort = dt.offsetNameShort || 'UTC';
    return dt.toFormat('h:mm a') + ' ' + tzShort;
}

function _format_area(areaDesc) {
    if (!areaDesc) return '';
    var items = areaDesc.split(/;\s*/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (items.length <= 1) return items.join('');
    return items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1];
}

function _build_threat_details(event, params, properties) {
    var e = event.toLowerCase();

    if (e.indexOf('severe thunderstorm') !== -1 && e.indexOf('warning') !== -1) {
        var wind = _arr(params.maxWindGust);
        var hail = _arr(params.maxHailSize);
        var hailNum = parseFloat(hail);
        var chunks = [];
        if (wind) chunks.push(wind + ' wind gusts');
        if (hail && !isNaN(hailNum) && hailNum > 0) {
            var hStr = hailNum < 1
                ? '<' + hail.replace(/^0\./, '.') + '" hail'
                : hailNum.toFixed(2) + '" hail';
            chunks.push(hStr);
        }
        return chunks.length ? chunks.join(', ') : null;
    }

    if (e.indexOf('tornado') !== -1 && e.indexOf('warning') !== -1) {
        var detection = _arr(params.tornadoDetection);
        var desc = ((properties.description || '') + '').toUpperCase();
        if (detection) return detection;
        if (desc.indexOf('OBSERVED') !== -1) return 'Tornado observed';
        if (desc.indexOf('RADAR INDICATED') !== -1) return 'Radar indicated rotation';
        return 'Radar indicated rotation';
    }

    if (e.indexOf('flash flood') !== -1 && e.indexOf('warning') !== -1) {
        var source = _arr(params.flashFloodDetection);
        var threat = _arr(params.flashFloodDamageThreat);
        var chunks = [];
        if (source) chunks.push(source);
        if (threat) chunks.push('Damage threat: ' + threat);
        return chunks.length ? chunks.join(', ') : 'Flash flooding expected';
    }

    if (e.indexOf('flood') !== -1 && e.indexOf('warning') !== -1) return 'Flooding expected';
    if (e.indexOf('blizzard') !== -1) return 'Blizzard conditions expected';
    if (e.indexOf('ice storm') !== -1) return 'Significant icing expected';
    if (e.indexOf('winter storm') !== -1 && e.indexOf('warning') !== -1) return 'Heavy snow or ice expected';
    if (e.indexOf('snow squall') !== -1) return 'Snow squall approaching';
    if (e.indexOf('hurricane') !== -1 && e.indexOf('warning') !== -1) return 'Hurricane conditions expected';
    if (e.indexOf('tropical storm') !== -1 && e.indexOf('warning') !== -1) return 'Tropical storm conditions expected';
    if (e.indexOf('storm surge') !== -1 && e.indexOf('warning') !== -1) return 'Life-threatening storm surge';
    if (e.indexOf('tsunami') !== -1 && e.indexOf('warning') !== -1) return 'Tsunami expected';
    if (e.indexOf('extreme wind') !== -1) return 'Extreme winds expected';

    return null;
}

function _extract_field(description, field) {
    var re = new RegExp('\\*?\\s*' + field + '\\.\\.\\.([\\s\\S]+?)(?=\\n\\s*\\*\\s*[A-Z]|\\.\\.\\.\\s*$|$)', 'i');
    var m = description.match(re);
    if (!m) return null;
    var val = m[1].replace(/\s+/g, ' ').trim().replace(/\.\s*$/, '');
    return val || null;
}

function _parse_structured_fields(description) {
    if (!description) return {};
    var result = {};
    var h = _extract_field(description, 'HAZARD');
    var s = _extract_field(description, 'SOURCE');
    var i = _extract_field(description, 'IMPACT');
    if (h) result.hazard = h;
    if (s) result.source = s;
    if (i) result.impact = i;
    return result;
}

function _build_ticker_text(feature) {
    var p = feature.properties || {};
    var params = p.parameters || {};
    var event = p.event || 'Weather Alert';
    var sender = (p.senderName || '').replace(/^NWS\s*/i, '');
    var area = _format_area(p.areaDesc);
    var expires = p.expires || p.ends || _arr(params.eventEndingTime);
    var untilStr = _format_until(expires, p);

    var issuer = sender
        ? 'The National Weather Service in ' + sender
        : 'The National Weather Service';

    var head = issuer + ' has issued a ' + event;
    if (area) head += ' for the following counties: ' + area;
    if (untilStr) head += ' until ' + untilStr + '.';

    var tail = [];
    var details = _build_threat_details(event, params, p);
    if (details) tail.push(details);

    var fields = _parse_structured_fields(p.description);
    if (fields.source) tail.push('Source: ' + fields.source + '.');
    if (fields.hazard) tail.push('Hazard: ' + fields.hazard + '.');
    if (fields.impact) tail.push('Impact: ' + fields.impact + '.');

    if (tail.length) return head + '  \u2014  ' + tail.join('  \u2014  ');
    return head;
}

function _is_alert_enabled(event) {
    var alerts_display_state = require('../alerts/alerts_display_state');
    return alerts_display_state.get_alert_type_enabled(event);
}

function _clear_phase() {
    if (_phaseTimer) { clearTimeout(_phaseTimer); _phaseTimer = null; }
}

function _reset_ticker(ticker, track) {
    ticker.classList.remove(
        'alertTicker-visible', 'alertTicker-scrolling',
        'alertTicker-tracer-in', 'alertTicker-tracer-out'
    );
    if (track) {
        track.style.animationName = 'none';
        track.removeEventListener('animationend', track._onAnimEnd);
        track._onAnimEnd = null;
    }
}

function _show_next() {
    _clear_phase();

    var ticker = document.getElementById('alertTicker');
    var track = ticker ? ticker.querySelector('.alertTickerTrack') : null;
    if (ticker) _reset_ticker(ticker, track);

    if (_queue.length === 0) {
        _playing = false;
        return;
    }

    _playing = true;
    var item = _queue.shift();

    var textEl = ticker ? ticker.querySelector('.alertTickerText') : null;
    if (!ticker || !textEl || !track) { _playing = false; return; }

    textEl.textContent = item.text;

    textEl.style.display = 'inline-block';
    void track.offsetWidth;
    var textWidth = textEl.offsetWidth || 400;
    var tickerWidth = ticker.offsetWidth || 300;
    var totalDistance = tickerWidth + textWidth;
    var durationPerLoop = Math.max(8, totalDistance / PIXELS_PER_SEC);
    ticker.style.setProperty('--ticker-duration', durationPerLoop.toFixed(1) + 's');
    ticker.style.setProperty('--ticker-loops', String(MAX_LOOPS));

    // Phase 1: slide up
    ticker.classList.add('alertTicker-visible');

    _phaseTimer = setTimeout(function () {
        // Phase 2: tracer sweeps right-to-left
        ticker.classList.add('alertTicker-tracer-in');

        _phaseTimer = setTimeout(function () {
            ticker.classList.remove('alertTicker-tracer-in');

            // Phase 3: text scrolls
            track.style.animationName = 'none';
            void track.offsetWidth;
            track.style.animationName = '';
            ticker.classList.add('alertTicker-scrolling');
            alert_voice.speak(item.text);

            var done = false;
            function onScrollDone() {
                if (done) return;
                done = true;
                track.removeEventListener('animationend', track._onAnimEnd);
                track._onAnimEnd = null;
                _clear_phase();

                // Phase 4: tracer sweeps left-to-right
                ticker.classList.remove('alertTicker-scrolling');
                track.style.animationName = 'none';
                ticker.classList.add('alertTicker-tracer-out');

                _phaseTimer = setTimeout(function () {
                    ticker.classList.remove('alertTicker-tracer-out');

                    // Phase 5: slide down
                    ticker.classList.remove('alertTicker-visible');

                    _phaseTimer = setTimeout(function () {
                        _show_next();
                    }, SLIDE_MS + 100);
                }, TRACER_MS);
            }

            track._onAnimEnd = onScrollDone;
            track.addEventListener('animationend', onScrollDone);

            var safetyMs = (durationPerLoop * MAX_LOOPS * 1000) + 2000;
            _phaseTimer = setTimeout(onScrollDone, safetyMs);
        }, TRACER_MS);
    }, SLIDE_MS);
}

function _enqueue_feature(feature, skipDedup) {
    var event = feature.properties?.event || 'Weather Alert';
    if (!_is_alert_enabled(event)) return;

    var id = feature.id || feature.properties?.id;
    if (!skipDedup && id && _shownIds.has(id)) return;
    if (id) _shownIds.add(id);

    var text = _build_ticker_text(feature);
    _queue.push({ text: text, event: event });

    if (!_playing) {
        _show_next();
    }
}

function init() {
    window.addEventListener('headerAlertBanner', function (e) {
        var detail = e.detail || {};
        var features = detail.features || [];
        var skipDedup = !!detail._devtest;
        for (var i = 0; i < features.length; i++) {
            _enqueue_feature(features[i], skipDedup);
        }
    });
}

module.exports = { init: init };
