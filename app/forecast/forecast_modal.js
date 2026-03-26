const { NEXRAD_LOCATIONS } = require('../radar/libnexrad/nexrad_locations');
const { get_closest_wsr88d_radar } = require('../alerts/alert_helpers');

var _overlay = null;
var _body = null;
var _searchInput = null;
var _spinner = null;
var _suggestions = null;
var _tabBar = null;
var _backBtn = null;
var _debounceTimer = null;
var _currentLat = null;
var _currentLon = null;
var _currentName = null;
var _cachedData = null;
var _activeTab = 'overview';
var _currentBoundaryGeojson = null;
var _currentOsmType = '';
var _currentOsmId = '';
var _currentTimeZone = '';
var _headerTitleEl = null;
var _headerTitleBaseEl = null;
var _headerTitleSepEl = null;
var _headerTitleSuffixEl = null;
var _headerSubEl = null;
var _headerClockTimer = null;
var _headerTypeTimer = null;

var NWS_UA = '(Vortex Radar, https://vortexradar.snapsera.com)';
var STORAGE_KEY_HISTORY = 'vortexRadar_forecastHistory';
var STORAGE_KEY_FAVORITES = 'vortexRadar_forecastFavorites';
var MAX_HISTORY = 15;
var URL_PARAM_MYCAST = 'mycast';
var URL_PARAM_MYCAST_LAT = 'mycastLat';
var URL_PARAM_MYCAST_LON = 'mycastLon';
var URL_PARAM_MYCAST_NAME = 'mycastName';
var DEFAULT_PAGE_TITLE = 'Vortex Radar | Advanced Weather';
var MYCAST_PAGE_TITLE = 'Vortex Radar | MyCast';
var DEFAULT_HEADER_SUBTITLE = 'Local Forecasts by the NWS';

// ── Persistence helpers ──

function _loadList(key) {
    try { return JSON.parse(localStorage.getItem(key)) || []; }
    catch (e) { return []; }
}
function _saveList(key, list) {
    try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) {}
}

function _addHistory(name, lat, lon) {
    var list = _loadList(STORAGE_KEY_HISTORY);
    list = list.filter(function(h) { return !(h.lat === lat && h.lon === lon); });
    list.unshift({ name: name, lat: lat, lon: lon, ts: Date.now() });
    if (list.length > MAX_HISTORY) list = list.slice(0, MAX_HISTORY);
    _saveList(STORAGE_KEY_HISTORY, list);
}

function _isFavorite(lat, lon) {
    var list = _loadList(STORAGE_KEY_FAVORITES);
    return list.some(function(f) { return f.lat === lat && f.lon === lon; });
}

function _toggleFavorite(name, lat, lon) {
    var list = _loadList(STORAGE_KEY_FAVORITES);
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
        if (list[i].lat === lat && list[i].lon === lon) { idx = i; break; }
    }
    if (idx >= 0) {
        list.splice(idx, 1);
    } else {
        list.unshift({ name: name, lat: lat, lon: lon });
    }
    _saveList(STORAGE_KEY_FAVORITES, list);
    return idx < 0;
}

function _removeFavorite(lat, lon) {
    var list = _loadList(STORAGE_KEY_FAVORITES);
    list = list.filter(function(f) { return !(f.lat === lat && f.lon === lon); });
    _saveList(STORAGE_KEY_FAVORITES, list);
}

function _removeHistory(lat, lon) {
    var list = _loadList(STORAGE_KEY_HISTORY);
    list = list.filter(function(h) { return !(h.lat === lat && h.lon === lon); });
    _saveList(STORAGE_KEY_HISTORY, list);
}

// ── Sunrise / sunset ──

function _julianDay(year, month, day) {
    if (month <= 2) { year--; month += 12; }
    var A = Math.floor(year / 100);
    var B = 2 - A + Math.floor(A / 4);
    return Math.floor(365.25 * (year + 4716)) + Math.floor(30.6001 * (month + 1)) + day + B - 1524.5;
}

function _sunTimes(lat, lon, date) {
    var jd = _julianDay(date.getFullYear(), date.getMonth() + 1, date.getDate());
    var n = Math.ceil(jd - 2451545.0 + 0.0008);
    var Jstar = n - (lon / 360);
    var M = (357.5291 + 0.98560028 * Jstar) % 360;
    var Mrad = M * Math.PI / 180;
    var C = 1.9148 * Math.sin(Mrad) + 0.02 * Math.sin(2 * Mrad) + 0.0003 * Math.sin(3 * Mrad);
    var lambda = (M + C + 180 + 102.9372) % 360;
    var lambdaRad = lambda * Math.PI / 180;
    var Jtransit = 2451545.0 + Jstar + 0.0053 * Math.sin(Mrad) - 0.0069 * Math.sin(2 * lambdaRad);
    var sinDec = Math.sin(lambdaRad) * Math.sin(23.4397 * Math.PI / 180);
    var cosDec = Math.cos(Math.asin(sinDec));
    var latRad = lat * Math.PI / 180;
    var cosH = (Math.sin(-0.833 * Math.PI / 180) - Math.sin(latRad) * sinDec) / (Math.cos(latRad) * cosDec);
    if (cosH > 1 || cosH < -1) return null;
    var H = Math.acos(cosH) * 180 / Math.PI;
    var Jrise = Jtransit - (H / 360);
    var Jset = Jtransit + (H / 360);
    function jdToDate(jdVal) { return new Date((jdVal - 2440587.5) * 86400000); }
    return { sunrise: jdToDate(Jrise), sunset: jdToDate(Jset) };
}

function _formatTime(d) {
    if (!d) return '--';
    var h = d.getHours(), m = d.getMinutes();
    var ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
}

function _daylightDuration(sun) {
    if (!sun) return '--';
    var ms = sun.sunset.getTime() - sun.sunrise.getTime();
    var hrs = Math.floor(ms / 3600000);
    var mins = Math.round((ms % 3600000) / 60000);
    return hrs + 'h ' + mins + 'm';
}

// ── Moon phase ──

function _moonPhase(date) {
    var year = date.getFullYear(), month = date.getMonth() + 1, day = date.getDate();
    if (month < 3) { year--; month += 12; }
    var A = Math.floor(year / 100), B = Math.floor(A / 4), C = 2 - A + B;
    var E = Math.floor(365.25 * (year + 4716)), F = Math.floor(30.6001 * (month + 1));
    var jd = C + day + E + F - 1524.5;
    var daysSinceNew = (jd - 2451550.1) % 29.530588853;
    if (daysSinceNew < 0) daysSinceNew += 29.530588853;
    var phase = daysSinceNew / 29.530588853;
    var illum = Math.round((1 - Math.cos(phase * 2 * Math.PI)) / 2 * 100);

    if (phase < 0.0625) return { name: 'New Moon', icon: 'fa-moon', illum: illum };
    if (phase < 0.1875) return { name: 'Waxing Crescent', icon: 'fa-moon', illum: illum };
    if (phase < 0.3125) return { name: 'First Quarter', icon: 'fa-circle-half-stroke', illum: illum };
    if (phase < 0.4375) return { name: 'Waxing Gibbous', icon: 'fa-moon', illum: illum };
    if (phase < 0.5625) return { name: 'Full Moon', icon: 'fa-circle', illum: illum };
    if (phase < 0.6875) return { name: 'Waning Gibbous', icon: 'fa-moon', illum: illum };
    if (phase < 0.8125) return { name: 'Last Quarter', icon: 'fa-circle-half-stroke', illum: illum };
    if (phase < 0.9375) return { name: 'Waning Crescent', icon: 'fa-moon', illum: illum };
    return { name: 'New Moon', icon: 'fa-moon', illum: illum };
}

// ── Weather icon mapping ──

function _weatherIcon(shortForecast, isDaytime) {
    var s = (shortForecast || '').toLowerCase();
    if (s.indexOf('tornado') !== -1) return 'fa-tornado';
    if (s.indexOf('hurricane') !== -1) return 'fa-hurricane';
    if (s.indexOf('thunder') !== -1 || s.indexOf('tstorm') !== -1) return 'fa-cloud-bolt';
    if (s.indexOf('snow') !== -1 || s.indexOf('blizzard') !== -1) return 'fa-snowflake';
    if (s.indexOf('sleet') !== -1 || s.indexOf('ice') !== -1 || s.indexOf('freezing') !== -1) return 'fa-icicles';
    if (s.indexOf('rain') !== -1 || s.indexOf('shower') !== -1 || s.indexOf('drizzle') !== -1) return 'fa-cloud-rain';
    if (s.indexOf('fog') !== -1 || s.indexOf('haze') !== -1 || s.indexOf('mist') !== -1) return 'fa-smog';
    if (s.indexOf('wind') !== -1) return 'fa-wind';
    if (s.indexOf('cloud') !== -1 || s.indexOf('overcast') !== -1) return 'fa-cloud';
    if (s.indexOf('partly') !== -1) return isDaytime ? 'fa-cloud-sun' : 'fa-cloud-moon';
    if (s.indexOf('sunny') !== -1 || s.indexOf('clear') !== -1) return isDaytime ? 'fa-sun' : 'fa-moon';
    return isDaytime ? 'fa-sun' : 'fa-moon';
}

function _tempColor(f) {
    if (f == null) return 'var(--color-text-primary)';
    if (f <= 0) return '#a5b4fc';
    if (f <= 32) return '#93c5fd';
    if (f <= 50) return '#67e8f9';
    if (f <= 65) return '#6ee7b7';
    if (f <= 80) return '#fbbf24';
    if (f <= 95) return '#fb923c';
    if (f <= 110) return '#f87171';
    return '#ef4444';
}

function _cToF(c) { return c != null ? Math.round(c * 9 / 5 + 32) : null; }
function _kmhToMph(k) { return k != null ? Math.round(k * 0.621371) : null; }
function _paToInHg(pa) { return pa != null ? (pa * 0.00029530).toFixed(2) : null; }
function _mToMi(m) { return m != null ? (m * 0.000621371).toFixed(1) : null; }

function _degreesToCardinal(deg) {
    if (deg == null) return '';
    var dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
}

// ── Geocoding ──

function _geocode(query, cb) {
    var url = 'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(query) +
        '&format=json&countrycodes=us&limit=5&addressdetails=1&polygon_geojson=1';
    fetch(url, { headers: { 'User-Agent': NWS_UA } })
        .then(function(r) { return r.json(); })
        .then(function(data) { cb(null, data); })
        .catch(function(err) { cb(err, null); });
}

function _isPolygonGeometry(geo) {
    return !!geo && (geo.type === 'Polygon' || geo.type === 'MultiPolygon');
}

function _nominatimTypePrefix(osmType) {
    if (osmType === 'relation') return 'R';
    if (osmType === 'way') return 'W';
    if (osmType === 'node') return 'N';
    return '';
}

function _lookupBoundary(osmType, osmId, cb) {
    var prefix = _nominatimTypePrefix(osmType);
    if (!prefix || !osmId) {
        cb(null);
        return;
    }
    var url = 'https://nominatim.openstreetmap.org/lookup?osm_ids=' + prefix + osmId +
        '&format=json&polygon_geojson=1';
    fetch(url, { headers: { 'User-Agent': NWS_UA } })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            var first = data && data[0];
            if (first && _isPolygonGeometry(first.geojson)) {
                cb(first.geojson);
                return;
            }
            cb(null);
        })
        .catch(function() { cb(null); });
}

function _resolveBoundaryFromResult(result, cb) {
    if (result && _isPolygonGeometry(result.geojson)) {
        cb(result.geojson);
        return;
    }
    _lookupBoundary(result && result.osm_type, result && result.osm_id, cb);
}

function _resolveBoundaryFromSuggestionItem($item, cb) {
    var rawBoundary = $item.attr('data-boundary');
    if (rawBoundary) {
        try {
            var parsed = JSON.parse(decodeURIComponent(rawBoundary));
            if (_isPolygonGeometry(parsed)) {
                cb(parsed);
                return;
            }
        } catch (_) {}
    }
    _lookupBoundary($item.attr('data-osm-type'), $item.attr('data-osm-id'), cb);
}

function _buildDisplayName(item) {
    var addr = item.address || {};
    var city = addr.city || addr.town || addr.village || addr.hamlet || addr.county || '';
    var state = addr.state || '';
    if (city && state) return city + ', ' + state;
    if (item.display_name) return item.display_name.split(',').slice(0, 3).join(',');
    return item.display_name || 'Unknown';
}

function _setMyCastShareUrl(lat, lon, name) {
    try {
        var url = new URL(window.location.href);
        url.searchParams.set(URL_PARAM_MYCAST, '1');
        if (lat != null && lon != null) {
            url.searchParams.set(URL_PARAM_MYCAST_LAT, Number(lat).toFixed(4));
            url.searchParams.set(URL_PARAM_MYCAST_LON, Number(lon).toFixed(4));
        }
        if (name) {
            url.searchParams.set(URL_PARAM_MYCAST_NAME, name);
        }
        window.history.replaceState({}, '', url.toString());
    } catch (_) {}
}

function _clearMyCastShareUrl() {
    try {
        var url = new URL(window.location.href);
        url.searchParams.delete(URL_PARAM_MYCAST);
        url.searchParams.delete(URL_PARAM_MYCAST_LAT);
        url.searchParams.delete(URL_PARAM_MYCAST_LON);
        url.searchParams.delete(URL_PARAM_MYCAST_NAME);
        window.history.replaceState({}, '', url.toString());
    } catch (_) {}
}

function _readMyCastShareParams() {
    try {
        var params = new URLSearchParams(window.location.search);
        if (params.get(URL_PARAM_MYCAST) !== '1') return null;
        var lat = parseFloat(params.get(URL_PARAM_MYCAST_LAT));
        var lon = parseFloat(params.get(URL_PARAM_MYCAST_LON));
        var name = params.get(URL_PARAM_MYCAST_NAME) || '';
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            return { openOnly: true, name: name };
        }
        return { lat: lat, lon: lon, name: name || null };
    } catch (_) {
        return null;
    }
}

function _clearHeaderTimers() {
    if (_headerClockTimer) {
        clearInterval(_headerClockTimer);
        _headerClockTimer = null;
    }
    if (_headerTypeTimer) {
        clearInterval(_headerTypeTimer);
        _headerTypeTimer = null;
    }
}

function _setHeaderTitle(text) {
    var safe = (text || 'MyCast');
    if (_headerTitleBaseEl && _headerTitleBaseEl.length) {
        _headerTitleBaseEl.text(safe);
    } else if (_headerTitleEl && _headerTitleEl.length) {
        _headerTitleEl.text(safe);
    }
    if (_headerTitleSepEl && _headerTitleSepEl.length) _headerTitleSepEl.hide();
    if (_headerTitleSuffixEl && _headerTitleSuffixEl.length) _headerTitleSuffixEl.text('');
}

function _setHeaderSubtitle(text) {
    if (_headerSubEl && _headerSubEl.length) _headerSubEl.text(text);
}

function _renderLocalTimeSubtitle() {
    if (_currentLat == null || _currentLon == null) {
        _setHeaderSubtitle(DEFAULT_HEADER_SUBTITLE);
        return;
    }
    try {
        var fmt = new Intl.DateTimeFormat('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
            timeZone: _currentTimeZone || undefined,
            timeZoneName: 'short'
        });
        _setHeaderSubtitle('Local time: ' + fmt.format(new Date()));
    } catch (_) {
        _setHeaderSubtitle(DEFAULT_HEADER_SUBTITLE);
    }
}

function _startHeaderClock() {
    if (_headerClockTimer) {
        clearInterval(_headerClockTimer);
        _headerClockTimer = null;
    }
    _renderLocalTimeSubtitle();
    if (_currentLat == null || _currentLon == null) return;
    _headerClockTimer = setInterval(_renderLocalTimeSubtitle, 1000);
}

function _animateHeaderTitle(locationName) {
    var clean = (locationName || '').trim();
    if (_headerTypeTimer) {
        clearInterval(_headerTypeTimer);
        _headerTypeTimer = null;
    }
    if (!clean) {
        _setHeaderTitle('MyCast');
        return;
    }
    var prefix = 'MyCast';
    var idx = 0;
    _setHeaderTitle(prefix);
    if (_headerTitleSepEl && _headerTitleSepEl.length) _headerTitleSepEl.css('display', 'inline-block');
    _headerTypeTimer = setInterval(function() {
        idx++;
        if (_headerTitleSuffixEl && _headerTitleSuffixEl.length) {
            _headerTitleSuffixEl.text(clean.slice(0, idx));
        }
        if (idx >= clean.length) {
            clearInterval(_headerTypeTimer);
            _headerTypeTimer = null;
        }
    }, 28);
}

function _setHeaderHomeState() {
    _clearHeaderTimers();
    _setHeaderTitle('MyCast');
    _setHeaderSubtitle(DEFAULT_HEADER_SUBTITLE);
}

function _setMyCastDocumentTitle(locationName) {
    var clean = (locationName || '').trim();
    if (clean) {
        document.title = MYCAST_PAGE_TITLE + ' | ' + clean;
        return;
    }
    document.title = MYCAST_PAGE_TITLE;
}

// ── NWS fetch ──

function _nwsFetch(url) {
    var headers = new Headers();
    headers.append('User-Agent', NWS_UA);
    headers.append('Accept', 'application/geo+json');
    return fetch(url, { headers: headers }).then(function(r) {
        if (!r.ok) throw new Error('NWS ' + r.status);
        return r.json();
    });
}

function _fetchAllData(lat, lon, cb) {
    var pointsUrl = 'https://api.weather.gov/points/' + lat.toFixed(4) + ',' + lon.toFixed(4);

    _nwsFetch(pointsUrl).then(function(points) {
        var props = points.properties;
        var forecastUrl = props.forecast;
        var hourlyUrl = props.forecastHourly;
        var stationsUrl = props.observationStations;
        var alertsUrl = 'https://api.weather.gov/alerts/active?point=' + lat.toFixed(4) + ',' + lon.toFixed(4);
        var locationName = (props.relativeLocation && props.relativeLocation.properties)
            ? props.relativeLocation.properties.city + ', ' + props.relativeLocation.properties.state
            : '';
        var gridId = props.gridId || '';
        var gridX = props.gridX;
        var gridY = props.gridY;
        var timeZone = props.timeZone || '';

        Promise.all([
            _nwsFetch(forecastUrl),
            _nwsFetch(hourlyUrl).catch(function() { return null; }),
            _nwsFetch(stationsUrl).then(function(s) {
                var first = s.features && s.features[0];
                if (!first) return null;
                var stationId = first.properties.stationIdentifier;
                var stationName = first.properties.name || stationId;
                return _nwsFetch('https://api.weather.gov/stations/' + stationId + '/observations/latest')
                    .then(function(obs) { obs._stationName = stationName; obs._stationId = stationId; return obs; });
            }).catch(function() { return null; }),
            _nwsFetch(alertsUrl).catch(function() { return { features: [] }; })
        ]).then(function(results) {
            cb(null, {
                forecast: results[0],
                hourly: results[1],
                observation: results[2],
                alerts: results[3],
                locationName: locationName,
                gridId: gridId,
                gridX: gridX,
                gridY: gridY,
                timeZone: timeZone
            });
        }).catch(function(err) { cb(err, null); });
    }).catch(function(err) { cb(err, null); });
}

// ── Render: Alerts ──

function _renderAlerts(alertsData) {
    var features = (alertsData && alertsData.features) || [];

    if (!features.length) {
        return '<div class="forecastAlertBannerClear">' +
            '<div class="forecastAlertBannerHeader forecastAlertBannerHeader-clear">' +
            '<i class="fa-solid fa-circle-check"></i> Active Alerts in This Area</div>' +
            '<div class="forecastAlertNone">No active weather alerts for this location.</div>' +
            '</div>';
    }

    var html = '<div class="forecastAlertBanner">';
    html += '<div class="forecastAlertBannerHeader"><i class="fa-solid fa-triangle-exclamation"></i> Active Alerts in This Area (' + features.length + ')</div>';

    for (var i = 0; i < features.length; i++) {
        var a = features[i].properties;
        var event = a.event || 'Unknown Alert';
        var severity = a.severity || '';
        var headline = a.headline || '';
        var sender = a.senderName || '';
        var onset = a.onset ? new Date(a.onset) : null;
        var expires = a.expires ? new Date(a.expires) : null;
        var description = a.description || '';
        var instruction = a.instruction || '';
        var areaDesc = a.areaDesc || '';

        html += '<div class="forecastAlertItem">';
        html += '<div class="forecastAlertItemTop">';
        html += '<div class="forecastAlertItemInfo">';
        html += '<div class="forecastAlertItemTitle">' + event + '</div>';
        if (headline) html += '<div class="forecastAlertItemHeadline">' + headline + '</div>';
        html += '<div class="forecastAlertItemMeta">';
        if (severity) html += '<span><i class="fa-solid fa-shield-halved"></i> ' + severity + '</span>';
        if (onset) html += '<span><i class="fa-solid fa-clock"></i> ' + onset.toLocaleString() + '</span>';
        if (expires) html += '<span><i class="fa-solid fa-hourglass-end"></i> Expires ' + expires.toLocaleString() + '</span>';
        if (sender) html += '<span><i class="fa-solid fa-building"></i> ' + sender + '</span>';
        html += '</div></div>';
        html += '<button class="forecastAlertDetailsBtn" data-alert-idx="' + i + '"><i class="fa-solid fa-chevron-down"></i> View Details</button>';
        html += '</div>';

        html += '<div class="forecastAlertDetailPanel" data-alert-detail="' + i + '">';
        if (areaDesc) html += '<div class="forecastAlertDetailSection"><span class="forecastAlertDetailLabel">Affected Areas</span><span class="forecastAlertDetailText">' + areaDesc + '</span></div>';
        if (description) html += '<div class="forecastAlertDetailSection"><span class="forecastAlertDetailLabel">Description</span><span class="forecastAlertDetailText">' + description.replace(/\n/g, '<br>') + '</span></div>';
        if (instruction) html += '<div class="forecastAlertDetailSection"><span class="forecastAlertDetailLabel">Instructions</span><span class="forecastAlertDetailText">' + instruction.replace(/\n/g, '<br>') + '</span></div>';
        html += '</div>';

        html += '</div>';
    }

    html += '</div>';
    return html;
}

// ── Render: Overview tab — hero + conditions + 7-day ──

function _renderOverview(data) {
    var obs = (data.observation && data.observation.properties) || {};
    var lat = _currentLat, lon = _currentLon;
    var html = '';

    // Hero
    var tempC = obs.temperature && obs.temperature.value;
    var tempF = _cToF(tempC);
    var desc = obs.textDescription || 'N/A';
    var heatC = obs.heatIndex && obs.heatIndex.value;
    var chillC = obs.windChill && obs.windChill.value;
    var feelsC = heatC != null ? heatC : (chillC != null ? chillC : tempC);
    var feelsF = _cToF(feelsC);
    var stationName = data.observation ? (data.observation._stationName || '') : '';

    html += '<div class="forecastHero">';
    html += '<span class="forecastHeroTemp" style="color:' + _tempColor(tempF) + '">' + (tempF != null ? tempF + '°' : '--') + '</span>';
    html += '<div class="forecastHeroInfo">';
    html += '<div class="forecastHeroCondition"><i class="fa-solid ' + _weatherIcon(desc, true) + ' forecastHeroConditionIcon"></i> ' + desc + '</div>';
    if (feelsF != null && feelsF !== tempF) html += '<div class="forecastHeroFeels">Feels like ' + feelsF + '°F</div>';
    if (stationName) html += '<div class="forecastHeroStation">Observed at ' + stationName + '</div>';
    html += '</div></div>';

    // Alerts
    html += _renderAlerts(data.alerts);

    // Conditions grid
    var windKmh = obs.windSpeed && obs.windSpeed.value;
    var windMph = _kmhToMph(windKmh);
    var windDir = obs.windDirection && obs.windDirection.value;
    var gustKmh = obs.windGust && obs.windGust.value;
    var gustMph = _kmhToMph(gustKmh);
    var humidity = obs.relativeHumidity && obs.relativeHumidity.value;
    var dewC = obs.dewpoint && obs.dewpoint.value;
    var dewF = _cToF(dewC);
    var pressurePa = obs.barometricPressure && obs.barometricPressure.value;
    var pressureInHg = _paToInHg(pressurePa);
    var visM = obs.visibility && obs.visibility.value;
    var visMi = _mToMi(visM);

    var sun = _sunTimes(lat, lon, new Date());
    var moon = _moonPhase(new Date());

    html += '<div class="forecastCurrent">';
    html += '<div class="forecastSectionLabel">Current Conditions</div>';
    html += '<div class="forecastCurrentGrid">';

    html += _card('fa-wind', 'Wind', (windMph != null ? windMph + ' mph ' + _degreesToCardinal(windDir) : '--'),
        gustMph ? 'Gusts ' + gustMph + ' mph' : null);
    html += _card('fa-droplet', 'Humidity', (humidity != null ? Math.round(humidity) + '%' : '--'), null);
    html += _card('fa-temperature-half', 'Dew Point', (dewF != null ? dewF + '°F' : '--'), null);
    html += _card('fa-gauge-high', 'Pressure', (pressureInHg != null ? pressureInHg + ' inHg' : '--'), null);
    html += _card('fa-eye', 'Visibility', (visMi != null ? visMi + ' mi' : '--'), null);
    html += _card('fa-sun', 'Sunrise', (sun ? _formatTime(sun.sunrise) : '--'), sun ? 'Daylight: ' + _daylightDuration(sun) : null);
    html += _card('fa-moon', 'Sunset', (sun ? _formatTime(sun.sunset) : '--'), null);
    html += _card(moon.icon, 'Moon Phase', moon.name, moon.illum + '% illumination');

    html += '</div></div>';

    // 7-day forecast
    html += _render7Day(data.forecast);

    return html;
}

function _card(icon, label, value, sub) {
    var h = '<div class="forecastCard">';
    h += '<span class="forecastCardLabel"><i class="fa-solid ' + icon + ' forecastCardIcon"></i> ' + label + '</span>';
    h += '<span class="forecastCardValue">' + value + '</span>';
    if (sub) h += '<span class="forecastCardSub">' + sub + '</span>';
    h += '</div>';
    return h;
}

// ── Render: 7-day forecast ──

function _render7Day(forecastData) {
    var periods = (forecastData && forecastData.properties && forecastData.properties.periods) || [];
    if (!periods.length) return '';

    var days = [];
    var allTemps = [];
    for (var i = 0; i < periods.length; i++) {
        var p = periods[i];
        allTemps.push(p.temperature);
        if (p.isDaytime) {
            var night = (i + 1 < periods.length && !periods[i + 1].isDaytime) ? periods[i + 1] : null;
            days.push({ day: p, night: night });
        }
    }
    var minTemp = Math.min.apply(null, allTemps);
    var maxTemp = Math.max.apply(null, allTemps);
    var tempRange = maxTemp - minTemp || 1;

    var html = '<div class="forecastDays">';
    html += '<div class="forecastSectionLabel">7 Day Forecast</div>';
    html += '<div class="forecastDayList">';

    for (var d = 0; d < days.length; d++) {
        var entry = days[d];
        var dayP = entry.day;
        var nightP = entry.night;
        var dt = new Date(dayP.startTime);
        var dayName = d === 0 ? 'Today' : dt.toLocaleDateString('en-US', { weekday: 'short' });
        var dateStr = (dt.getMonth() + 1) + '/' + dt.getDate();
        var icon = _weatherIcon(dayP.shortForecast, true);
        var high = dayP.temperature;
        var low = nightP ? nightP.temperature : null;
        var precip = dayP.probabilityOfPrecipitation && dayP.probabilityOfPrecipitation.value;
        var precipStr = precip != null && precip > 0 ? precip + '%' : '';
        var wind = dayP.windSpeed || '';

        var barLeft = ((low != null ? low : high) - minTemp) / tempRange * 100;
        var barRight = (high - minTemp) / tempRange * 100;

        html += '<div class="forecastDayRow" data-day-idx="' + d + '">';
        html += '<span class="forecastDayName">' + dayName + '</span>';
        html += '<span class="forecastDayDate">' + dateStr + '</span>';
        html += '<span class="forecastDayIcon" style="color:' + _tempColor(high) + '"><i class="fa-solid ' + icon + '"></i></span>';
        html += '<span class="forecastDayTemps"><span class="forecastDayHigh" style="color:' + _tempColor(high) + '">' + high + '°</span><span class="forecastDayLow">' + (low != null ? low + '°' : '') + '</span></span>';
        html += '<div class="forecastTempBar"><div class="forecastTempBarFill" style="left:' + barLeft + '%;width:' + (barRight - barLeft) + '%;background:linear-gradient(90deg,' + _tempColor(low != null ? low : high) + ',' + _tempColor(high) + ')"></div></div>';
        html += '<span class="forecastDayDesc">' + dayP.shortForecast + '</span>';
        html += '<span class="forecastDayMeta">';
        if (precipStr) html += '<span class="forecastDayPrecip"><i class="fa-solid fa-droplet"></i> ' + precipStr + '</span>';
        html += '<span class="forecastDayWind"><i class="fa-solid fa-wind"></i> ' + wind + '</span>';
        html += '</span>';
        html += '<i class="fa-solid fa-chevron-right forecastDayChevron"></i>';
        html += '</div>';

        // Detail panel
        html += '<div class="forecastDayDetail" data-day-detail="' + d + '">';
        html += '<div class="forecastDayDetailGrid">';
        html += _detailItem('High', high + '°F');
        html += _detailItem('Low', low != null ? low + '°F' : '--');
        html += _detailItem('Wind', wind);
        html += _detailItem('Precip', precipStr || '0%');
        if (dayP.windDirection) html += _detailItem('Wind Dir', dayP.windDirection);
        html += '</div>';
        html += '<div class="forecastDayDetailText">' + dayP.detailedForecast + '</div>';

        if (nightP) {
            html += '<div class="forecastDayDetailNight">';
            html += '<div class="forecastDayDetailNightLabel"><i class="fa-solid fa-moon"></i> ' + nightP.name + '</div>';
            html += '<div class="forecastDayDetailGrid">';
            html += _detailItem('Low', nightP.temperature + '°F');
            html += _detailItem('Wind', nightP.windSpeed || '--');
            var nightPrecip = nightP.probabilityOfPrecipitation && nightP.probabilityOfPrecipitation.value;
            html += _detailItem('Precip', (nightPrecip != null && nightPrecip > 0) ? nightPrecip + '%' : '0%');
            html += '</div>';
            html += '<div class="forecastDayDetailText">' + nightP.detailedForecast + '</div>';
            html += '</div>';
        }
        html += '</div>';
    }

    html += '</div></div>';
    return html;
}

function _detailItem(label, value) {
    return '<div class="forecastDayDetailItem"><span class="forecastDayDetailLabel">' + label + '</span><span class="forecastDayDetailValue">' + value + '</span></div>';
}

// ── Render: Hourly tab ──

function _renderHourly(hourlyData) {
    var periods = (hourlyData && hourlyData.properties && hourlyData.properties.periods) || [];
    if (!periods.length) return '<div class="forecastEmpty"><div class="forecastEmptyText">Hourly data unavailable.</div></div>';

    var limit = Math.min(periods.length, 72);
    var html = '<div class="forecastHourlyWrap">';
    html += '<div class="forecastSectionLabel">Hourly Forecast — Next 72 Hours</div>';
    html += '<div class="forecastHourlyList">';

    html += '<div class="forecastHourlyColHeader">';
    html += '<span style="width:65px">Time</span>';
    html += '<span style="width:22px"></span>';
    html += '<span style="width:44px">Temp</span>';
    html += '<span style="flex:1">Conditions</span>';
    html += '<span style="width:40px">Precip</span>';
    html += '<span style="width:40px">Humid</span>';
    html += '<span style="width:70px">Wind</span>';
    html += '</div>';

    var lastDay = '';
    for (var i = 0; i < limit; i++) {
        var p = periods[i];
        var dt = new Date(p.startTime);
        var dayLabel = dt.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

        if (dayLabel !== lastDay) {
            html += '<div class="forecastHourlyDaySep">' + dayLabel + '</div>';
            lastDay = dayLabel;
        }

        var timeStr = _formatTime(dt);
        var icon = _weatherIcon(p.shortForecast, p.isDaytime);
        var temp = p.temperature;
        var precip = p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value;
        var precipStr = (precip != null && precip > 0) ? precip + '%' : '';
        var humidity = p.relativeHumidity && p.relativeHumidity.value;
        var humidStr = humidity != null ? Math.round(humidity) + '%' : '';
        var wind = p.windSpeed || '';

        html += '<div class="forecastHourlyRow">';
        html += '<span class="forecastHourlyTime">' + timeStr + '</span>';
        html += '<span class="forecastHourlyIcon" style="color:' + _tempColor(temp) + '"><i class="fa-solid ' + icon + '"></i></span>';
        html += '<span class="forecastHourlyTemp" style="color:' + _tempColor(temp) + '">' + temp + '°</span>';
        html += '<span class="forecastHourlyDesc">' + p.shortForecast + '</span>';
        html += '<span class="forecastHourlyPrecip">' + precipStr + '</span>';
        html += '<span class="forecastHourlyHumidity">' + humidStr + '</span>';
        html += '<span class="forecastHourlyWind">' + wind + '</span>';
        html += '</div>';
    }

    html += '</div></div>';
    return html;
}

// ── Render: Details tab ──

function _renderDetails(data) {
    var obs = (data.observation && data.observation.properties) || {};
    var lat = _currentLat, lon = _currentLon;
    var html = '<div class="forecastDetailsWrap">';

    // Observation details
    var tempC = obs.temperature && obs.temperature.value;
    var tempF = _cToF(tempC);
    var dewC = obs.dewpoint && obs.dewpoint.value;
    var dewF = _cToF(dewC);
    var humidity = obs.relativeHumidity && obs.relativeHumidity.value;
    var windKmh = obs.windSpeed && obs.windSpeed.value;
    var windMph = _kmhToMph(windKmh);
    var windDir = obs.windDirection && obs.windDirection.value;
    var gustKmh = obs.windGust && obs.windGust.value;
    var gustMph = _kmhToMph(gustKmh);
    var pressurePa = obs.barometricPressure && obs.barometricPressure.value;
    var pressureInHg = _paToInHg(pressurePa);
    var visM = obs.visibility && obs.visibility.value;
    var visMi = _mToMi(visM);
    var heatC = obs.heatIndex && obs.heatIndex.value;
    var heatF = _cToF(heatC);
    var chillC = obs.windChill && obs.windChill.value;
    var chillF = _cToF(chillC);
    var cloudLayers = obs.cloudLayers || [];
    var rawDesc = obs.rawMessage || '';
    var observedAt = obs.timestamp ? new Date(obs.timestamp) : null;

    var sun = _sunTimes(lat, lon, new Date());
    var moon = _moonPhase(new Date());

    html += '<div class="forecastDetailSection">';
    html += '<div class="forecastSectionLabel">Observation Details</div>';
    html += _dRow('fa-temperature-half', 'Temperature', tempF != null ? tempF + '°F (' + (tempC != null ? tempC.toFixed(1) : '--') + '°C)' : '--');
    html += _dRow('fa-temperature-half', 'Dew Point', dewF != null ? dewF + '°F (' + (dewC != null ? dewC.toFixed(1) : '--') + '°C)' : '--');
    html += _dRow('fa-droplet', 'Humidity', humidity != null ? Math.round(humidity) + '%' : '--');
    html += _dRow('fa-wind', 'Wind', windMph != null ? windMph + ' mph ' + _degreesToCardinal(windDir) + ' (' + (windDir != null ? windDir + '°' : '') + ')' : '--');
    html += _dRow('fa-wind', 'Gusts', gustMph != null ? gustMph + ' mph' : 'None');
    html += _dRow('fa-gauge-high', 'Barometric Pressure', pressureInHg != null ? pressureInHg + ' inHg (' + (pressurePa != null ? Math.round(pressurePa / 100) + ' hPa' : '') + ')' : '--');
    html += _dRow('fa-eye', 'Visibility', visMi != null ? visMi + ' mi' : '--');
    if (heatF != null) html += _dRow('fa-temperature-arrow-up', 'Heat Index', heatF + '°F');
    if (chillF != null) html += _dRow('fa-temperature-arrow-down', 'Wind Chill', chillF + '°F');

    if (cloudLayers.length) {
        var cloudStr = cloudLayers.map(function(l) {
            var base = l.base && l.base.value != null ? Math.round(l.base.value * 3.28084) + ' ft' : '';
            return (l.amount || '') + (base ? ' at ' + base : '');
        }).join(', ');
        html += _dRow('fa-cloud', 'Cloud Cover', cloudStr);
    }

    if (observedAt) html += _dRow('fa-clock', 'Observed', observedAt.toLocaleString());
    var stationName = data.observation ? (data.observation._stationName || '') : '';
    var stationId = data.observation ? (data.observation._stationId || '') : '';
    if (stationName) html += _dRow('fa-tower-broadcast', 'Station', stationName + (stationId ? ' (' + stationId + ')' : ''));
    html += '</div>';

    // Sun & Moon
    html += '<div class="forecastDetailSection">';
    html += '<div class="forecastSectionLabel">Sun &amp; Moon</div>';
    html += _dRow('fa-sun', 'Sunrise', sun ? _formatTime(sun.sunrise) : '--');
    html += _dRow('fa-sun', 'Sunset', sun ? _formatTime(sun.sunset) : '--');
    html += _dRow('fa-hourglass-half', 'Daylight', _daylightDuration(sun));
    html += _dRow(moon.icon, 'Moon Phase', moon.name + ' (' + moon.illum + '% illumination)');
    html += '</div>';

    // Location info
    html += '<div class="forecastDetailSection">';
    html += '<div class="forecastSectionLabel">Location</div>';
    html += _dRow('fa-location-dot', 'Coordinates', lat.toFixed(4) + ', ' + lon.toFixed(4));
    html += _dRow('fa-map-pin', 'NWS Grid', data.gridId + ' (' + data.gridX + ', ' + data.gridY + ')');
    html += _dRow('fa-map', 'Forecast Office', data.gridId);
    html += '</div>';

    // Raw METAR
    if (rawDesc) {
        html += '<div class="forecastDetailSection">';
        html += '<div class="forecastSectionLabel">Raw Observation (METAR)</div>';
        html += '<div class="forecastDetailTextBlock">' + rawDesc + '</div>';
        html += '</div>';
    }

    // Full text forecast
    var periods = (data.forecast && data.forecast.properties && data.forecast.properties.periods) || [];
    if (periods.length) {
        html += '<div class="forecastDetailSection">';
        html += '<div class="forecastSectionLabel">Full Text Forecast</div>';
        for (var i = 0; i < periods.length; i++) {
            var p = periods[i];
            html += '<div class="forecastDetailTextBlock"><strong>' + p.name + ':</strong> ' + p.detailedForecast + '</div>';
        }
        html += '</div>';
    }

    html += '</div>';
    return html;
}

function _dRow(icon, label, value) {
    return '<div class="forecastDetailRow">' +
        '<span class="forecastDetailRowIcon"><i class="fa-solid ' + icon + '"></i></span>' +
        '<span class="forecastDetailRowLabel">' + label + '</span>' +
        '<span class="forecastDetailRowValue">' + value + '</span>' +
        '</div>';
}

function _renderRadarAlertsSummary(alertsData) {
    var features = (alertsData && alertsData.features) || [];
    if (!features.length) {
        return '<div class="forecastRadarAlertSummary forecastRadarAlertSummary-clear">' +
            '<i class="fa-solid fa-circle-check"></i>' +
            '<span>No active alerts near this location.</span>' +
            '</div>';
    }

    var counts = {};
    for (var i = 0; i < features.length; i++) {
        var eventName = (features[i].properties && features[i].properties.event) || 'Weather Alert';
        counts[eventName] = (counts[eventName] || 0) + 1;
    }
    var labels = Object.keys(counts).slice(0, 5).map(function(k) {
        return counts[k] > 1 ? k + ' (' + counts[k] + ')' : k;
    });
    var hasMore = Object.keys(counts).length > 5;

    return '<div class="forecastRadarAlertSummary forecastRadarAlertSummary-active">' +
        '<i class="fa-solid fa-triangle-exclamation"></i>' +
        '<span>' + features.length + ' active alert' + (features.length === 1 ? '' : 's') + ': ' + labels.join(' • ') + (hasMore ? ' • ...' : '') + '</span>' +
        '</div>';
}

function _buildRadarPreviewUrl(lat, lon, boundaryGeojson, osmType, osmId) {
    var url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('radarPreview', '1');
    url.searchParams.set('lat', lat.toFixed(4));
    url.searchParams.set('lon', lon.toFixed(4));
    if (osmType) url.searchParams.set('osmType', osmType);
    if (osmId) url.searchParams.set('osmId', String(osmId));
    if (boundaryGeojson) {
        try {
            var key = 'vortexRadar_previewBoundary_' + Date.now() + '_' + Math.floor(Math.random() * 1000000);
            sessionStorage.setItem(key, JSON.stringify(boundaryGeojson));
            url.searchParams.set('boundaryKey', key);
        } catch (_) {}
    }
    return url.toString();
}

function _renderRadarPreviewCard(data) {
    var stationId = (_currentLon != null && _currentLat != null)
        ? get_closest_wsr88d_radar(_currentLon, _currentLat)
        : null;
    var stationMeta = stationId ? NEXRAD_LOCATIONS[stationId] : null;
    var stationLabel = stationMeta
        ? stationId + ' - ' + stationMeta.name
        : 'Unavailable';

    var html = '<div class="forecastRadarPanel">';
    html += '<div class="forecastRadarTitle"><i class="fa-solid fa-satellite-dish"></i> Radar Preview</div>';
    html += '<div class="forecastRadarMeta"><span class="forecastRadarMetaLabel">Radar Site</span><span class="forecastRadarMetaValue">' + stationLabel + '</span></div>';
    html += '<div class="forecastRadarFrameWrap">';
    html += '<iframe class="forecastRadarFrame" title="Radar Preview" src="' + _buildRadarPreviewUrl(_currentLat, _currentLon, _currentBoundaryGeojson, _currentOsmType, _currentOsmId) + '" loading="lazy" referrerpolicy="no-referrer"></iframe>';
    html += '</div>';
    html += '</div>';
    return html;
}

// ── Tab switching ──

function _switchTab(tab) {
    _activeTab = tab;
    _tabBar.find('.forecastTab').removeClass('forecastTab-active');
    _tabBar.find('[data-tab="' + tab + '"]').addClass('forecastTab-active');
    _body.find('.forecastTabContent').removeClass('forecastTabContent-active');
    _body.find('[data-tab-content="' + tab + '"]').addClass('forecastTabContent-active');
}

// ── Load location ──

function _showLandingHome() {
    _currentLat = null;
    _currentLon = null;
    _currentName = null;
    _currentTimeZone = '';
    _tabBar.hide();
    if (_backBtn) _backBtn.hide();
    _searchInput.val('');
    _suggestions.removeClass('forecastSuggestions-visible');
    _body.html(_renderLanding());
    _setHeaderHomeState();
    _setMyCastDocumentTitle('');
    _clearMyCastShareUrl();
}

function _loadForecast(lat, lon, displayName, boundaryGeojson, osmType, osmId) {
    _currentLat = lat;
    _currentLon = lon;
    _currentName = displayName;
    _currentBoundaryGeojson = boundaryGeojson || null;
    _currentOsmType = osmType || '';
    _currentOsmId = osmId != null ? String(osmId) : '';
    _currentTimeZone = '';
    _cachedData = null;
    _activeTab = 'overview';
    _setMyCastShareUrl(lat, lon, displayName);

    if (_backBtn) _backBtn.css('display', 'inline-flex');
    _tabBar.hide();
    _body.html(
        '<div class="forecastLoading">' +
        '<img class="forecastLoadingLogo" src="images/vortexicon_rotate.svg" alt="Loading">' +
        '<div class="forecastLoadingText">Loading forecast data...</div>' +
        '</div>'
    );

    _fetchAllData(lat, lon, function(err, data) {
        if (err) {
            _body.html('<div class="forecastTabContent forecastTabContent-active" style="padding:var(--space-4) var(--space-5)">' +
                '<div class="forecastError"><i class="fa-solid fa-circle-exclamation"></i> Failed to load forecast. Please try another location.</div></div>');
            return;
        }

        _cachedData = data;
        var name = displayName || data.locationName || 'Unknown Location';
        _currentName = name;
        _setMyCastDocumentTitle(name);
        _currentTimeZone = data.timeZone || '';
        _animateHeaderTitle(name);
        _startHeaderClock();
        _addHistory(name, lat, lon);

        var favActive = _isFavorite(lat, lon);
        var locationHtml = '<div class="forecastLocation">' +
            '<i class="fa-solid fa-location-dot forecastLocationIcon"></i>' +
            '<span class="forecastLocationName">' + name + '</span>' +
            '<button class="forecastFavBtn' + (favActive ? ' forecastFavBtn-active' : '') + '" id="forecastFavBtn" title="' + (favActive ? 'Remove from favorites' : 'Add to favorites') + '"><i class="fa-' + (favActive ? 'solid' : 'regular') + ' fa-star"></i></button>' +
            '<span class="forecastLocationSub"><span>' + lat.toFixed(4) + ', ' + lon.toFixed(4) + '</span>' +
            (data.gridId ? '<span>NWS: ' + data.gridId + '</span>' : '') +
            '</span></div>';

        var overviewHtml = '<div class="forecastOverviewSplit">' +
            '<div class="forecastOverviewMain">' + _renderOverview(data) + '</div>' +
            '<div class="forecastOverviewSide">' + _renderRadarPreviewCard(data) + '</div>' +
            '</div>';

        var html = '';
        html += '<div class="forecastTabContent forecastTabContent-active" data-tab-content="overview">' + locationHtml + overviewHtml + '</div>';
        html += '<div class="forecastTabContent" data-tab-content="hourly">' + locationHtml + _renderHourly(data.hourly) + '</div>';
        html += '<div class="forecastTabContent" data-tab-content="details">' + locationHtml + _renderDetails(data) + '</div>';

        _body.html(html);
        _tabBar.css('display', 'flex');
        if (_backBtn) _backBtn.css('display', 'inline-flex');

        _tabBar.find('.forecastTab').removeClass('forecastTab-active');
        _tabBar.find('[data-tab="overview"]').addClass('forecastTab-active');
    });
}

// ── Search handling ──

function _onSearchInput() {
    var q = _searchInput.val().trim();
    if (_debounceTimer) clearTimeout(_debounceTimer);
    if (q.length < 2) {
        _suggestions.removeClass('forecastSuggestions-visible');
        return;
    }
    _spinner.addClass('forecastSearchSpinner-active');
    _debounceTimer = setTimeout(function() {
        _geocode(q, function(err, results) {
            _spinner.removeClass('forecastSearchSpinner-active');
            if (err || !results || !results.length) {
                _suggestions.removeClass('forecastSuggestions-visible');
                return;
            }
            var html = '';
            for (var i = 0; i < results.length; i++) {
                var r = results[i];
                var boundaryEncoded = '';
                if (r.geojson) {
                    try { boundaryEncoded = encodeURIComponent(JSON.stringify(r.geojson)); } catch (_) {}
                }
                html += '<div class="forecastSuggestionItem" data-lat="' + r.lat + '" data-lon="' + r.lon + '" data-name="' + _buildDisplayName(r).replace(/"/g, '&quot;') + '" data-boundary="' + boundaryEncoded.replace(/"/g, '&quot;') + '" data-osm-type="' + (r.osm_type || '') + '" data-osm-id="' + (r.osm_id || '') + '">' +
                    _buildDisplayName(r) + '</div>';
            }
            _suggestions.html(html).addClass('forecastSuggestions-visible');
        });
    }, 350);
}

function _onSuggestionClick(e) {
    var $item = $(e.target).closest('.forecastSuggestionItem');
    if (!$item.length) return;
    _searchInput.val($item.attr('data-name'));
    _suggestions.removeClass('forecastSuggestions-visible');
    _spinner.addClass('forecastSearchSpinner-active');
    var osmType = $item.attr('data-osm-type') || '';
    var osmId = $item.attr('data-osm-id') || '';
    _resolveBoundaryFromSuggestionItem($item, function(boundary) {
        _spinner.removeClass('forecastSearchSpinner-active');
        _loadForecast(parseFloat($item.attr('data-lat')), parseFloat($item.attr('data-lon')), $item.attr('data-name'), boundary, osmType, osmId);
    });
}

function _onSearchKeydown(e) {
    if (e.key === 'Enter' || e.keyCode === 13) {
        e.preventDefault();
        var q = _searchInput.val().trim();
        if (!q) return;
        _suggestions.removeClass('forecastSuggestions-visible');
        _spinner.addClass('forecastSearchSpinner-active');
        _geocode(q, function(err, results) {
            _spinner.removeClass('forecastSearchSpinner-active');
            if (!results || !results.length) {
                _body.html('<div class="forecastTabContent forecastTabContent-active" style="padding:var(--space-4) var(--space-5)">' +
                    '<div class="forecastError"><i class="fa-solid fa-circle-exclamation"></i> No results found. Try a different search.</div></div>');
                return;
            }
            var r = results[0];
            var name = _buildDisplayName(r);
            _searchInput.val(name);
            _resolveBoundaryFromResult(r, function(boundary) {
                _loadForecast(parseFloat(r.lat), parseFloat(r.lon), name, boundary, r.osm_type || '', r.osm_id || '');
            });
        });
    }
}

// ── Landing page (Favorites + History) ──

function _renderLanding() {
    var favorites = _loadList(STORAGE_KEY_FAVORITES);
    var history = _loadList(STORAGE_KEY_HISTORY);

    var html = '<div class="forecastLanding">';

    // Landing tabs
    html += '<div class="forecastLandingTabs">';
    html += '<button class="forecastLandingTab forecastLandingTab-active" data-landing-tab="favorites"><i class="fa-solid fa-star forecastTabIcon"></i> Favorites</button>';
    html += '<button class="forecastLandingTab" data-landing-tab="recents"><i class="fa-solid fa-clock-rotate-left forecastTabIcon"></i> Recent Searches</button>';
    html += '</div>';

    // Favorites panel
    html += '<div class="forecastLandingPanel forecastLandingPanel-active" data-landing-panel="favorites">';
    if (favorites.length) {
        html += '<div class="forecastSavedList">';
        for (var f = 0; f < favorites.length; f++) {
            var fav = favorites[f];
            html += '<div class="forecastSavedRow" data-lat="' + fav.lat + '" data-lon="' + fav.lon + '" data-name="' + (fav.name || '').replace(/"/g, '&quot;') + '">';
            html += '<i class="fa-solid fa-star forecastSavedIcon forecastSavedIcon-fav"></i>';
            html += '<span class="forecastSavedName">' + fav.name + '</span>';
            html += '<span class="forecastSavedCoords">' + parseFloat(fav.lat).toFixed(2) + ', ' + parseFloat(fav.lon).toFixed(2) + '</span>';
            html += '<button class="forecastSavedRemove forecastSavedRemoveFav" data-lat="' + fav.lat + '" data-lon="' + fav.lon + '" title="Remove"><i class="fa-solid fa-xmark"></i></button>';
            html += '</div>';
        }
        html += '</div>';
    } else {
        html += '<div class="forecastLandingEmpty"><i class="fa-regular fa-star forecastLandingEmptyIcon"></i>';
        html += '<div class="forecastLandingEmptyText">No favorites yet.<br>Search for a location and tap the star to save it.</div></div>';
    }
    html += '</div>';

    // History panel
    html += '<div class="forecastLandingPanel" data-landing-panel="recents">';
    if (history.length) {
        html += '<div class="forecastSavedList">';
        for (var h = 0; h < history.length; h++) {
            var item = history[h];
            var ago = _timeAgo(item.ts);
            html += '<div class="forecastSavedRow" data-lat="' + item.lat + '" data-lon="' + item.lon + '" data-name="' + (item.name || '').replace(/"/g, '&quot;') + '">';
            html += '<i class="fa-solid fa-clock-rotate-left forecastSavedIcon"></i>';
            html += '<span class="forecastSavedName">' + item.name + '</span>';
            html += '<span class="forecastSavedAgo">' + ago + '</span>';
            html += '<button class="forecastSavedRemove forecastSavedRemoveHistory" data-lat="' + item.lat + '" data-lon="' + item.lon + '" title="Remove"><i class="fa-solid fa-xmark"></i></button>';
            html += '</div>';
        }
        html += '</div>';
    } else {
        html += '<div class="forecastLandingEmpty"><i class="fa-solid fa-clock-rotate-left forecastLandingEmptyIcon"></i>';
        html += '<div class="forecastLandingEmptyText">No recent searches.</div></div>';
    }
    html += '</div>';

    html += '</div>';
    return html;
}

function _timeAgo(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.floor(hrs / 24);
    if (days === 1) return 'Yesterday';
    if (days < 7) return days + 'd ago';
    return new Date(ts).toLocaleDateString();
}

// ── Open / close ──

function _open() {
    _overlay.addClass('forecastOverlay-visible');
    _setMyCastDocumentTitle('');
    _setHeaderHomeState();
    var shared = _readMyCastShareParams();
    if (shared && Number.isFinite(shared.lat) && Number.isFinite(shared.lon)) {
        _searchInput.val(shared.name || '');
        _loadForecast(shared.lat, shared.lon, shared.name || '');
    } else {
        _showLandingHome();
    }
    setTimeout(function() { _searchInput.focus(); }, 100);
}

function _close() {
    _overlay.removeClass('forecastOverlay-visible');
    _clearHeaderTimers();
    _clearMyCastShareUrl();
    document.title = DEFAULT_PAGE_TITLE;
}

// ── Build DOM ──

function _buildOverlay() {
    var html =
        '<div class="forecastOverlay" id="forecastOverlay">' +
            '<div class="forecastModal">' +
                '<div class="forecastHeader">' +
                    '<div class="forecastHeaderLeft">' +
                        '<span class="forecastHeaderTitle" id="forecastHeaderTitle">' +
                            '<span class="forecastHeaderTitleBase" id="forecastHeaderTitleBase">MyCast</span>' +
                            '<img class="forecastHeaderTitleSep" id="forecastHeaderTitleSep" src="images/vortexicon_rotate.svg" alt="" aria-hidden="true" style="display:none">' +
                            '<span class="forecastHeaderTitleSuffix" id="forecastHeaderTitleSuffix"></span>' +
                        '</span>' +
                        '<span class="forecastHeaderSub" id="forecastHeaderSub">Local Forecasts by the NWS</span>' +
                    '</div>' +
                    '<button type="button" class="forecastCloseBtn" id="forecastCloseBtn" aria-label="Close">Close</button>' +
                '</div>' +
                '<div class="forecastSidebar">' +
                    '<div class="forecastSearch">' +
                        '<i class="fa-solid fa-magnifying-glass forecastSearchIcon"></i>' +
                        '<div class="forecastSearchWrap">' +
                            '<input type="text" class="forecastSearchInput" id="forecastSearchInput" placeholder="Search city, state, or zip..." autocomplete="off">' +
                            '<div class="forecastSuggestions" id="forecastSuggestions"></div>' +
                        '</div>' +
                        '<div class="forecastSearchSpinner" id="forecastSearchSpinner"></div>' +
                    '</div>' +
                    '<button type="button" class="forecastBackBtn" id="forecastBackBtn" style="display:none"><i class="fa-solid fa-arrow-left"></i> Back to Home</button>' +
                    '<div class="forecastTabs" id="forecastTabs" style="display:none">' +
                        '<button class="forecastTab forecastTab-active" data-tab="overview"><i class="fa-solid fa-cloud-sun forecastTabIcon"></i> Overview</button>' +
                        '<button class="forecastTab" data-tab="hourly"><i class="fa-solid fa-clock forecastTabIcon"></i> Hourly</button>' +
                        '<button class="forecastTab" data-tab="details"><i class="fa-solid fa-list forecastTabIcon"></i> Details</button>' +
                    '</div>' +
                '</div>' +
                '<div class="forecastBody" id="forecastBody"></div>' +
            '</div>' +
        '</div>';
    $('body').append(html);

    _overlay = $('#forecastOverlay');
    _body = $('#forecastBody');
    _searchInput = $('#forecastSearchInput');
    _spinner = $('#forecastSearchSpinner');
    _suggestions = $('#forecastSuggestions');
    _tabBar = $('#forecastTabs');
    _backBtn = $('#forecastBackBtn');
    _headerTitleEl = $('#forecastHeaderTitle');
    _headerTitleBaseEl = $('#forecastHeaderTitleBase');
    _headerTitleSepEl = $('#forecastHeaderTitleSep');
    _headerTitleSuffixEl = $('#forecastHeaderTitleSuffix');
    _headerSubEl = $('#forecastHeaderSub');

    $('#forecastCloseBtn').on('click', _close);
    _overlay.on('click', function(e) {
        if ($(e.target).hasClass('forecastOverlay')) _close();
    });
    _searchInput.on('input', _onSearchInput);
    _searchInput.on('keydown', _onSearchKeydown);
    _suggestions.on('click', _onSuggestionClick);

    _tabBar.on('click', '.forecastTab', function() {
        _switchTab($(this).attr('data-tab'));
    });
    _backBtn.on('click', _showLandingHome);

    // Day row expand/collapse (delegated — registered once)
    _body.on('click', '.forecastDayRow', function() {
        var idx = $(this).attr('data-day-idx');
        $(this).toggleClass('forecastDayRow-expanded');
        _body.find('[data-day-detail="' + idx + '"]').toggleClass('forecastDayDetail-visible');
    });

    // Alert detail expand/collapse (delegated — registered once)
    _body.on('click', '.forecastAlertDetailsBtn', function(e) {
        e.stopPropagation();
        var idx = $(this).attr('data-alert-idx');
        var panel = _body.find('[data-alert-detail="' + idx + '"]');
        var isOpen = panel.hasClass('forecastAlertDetailPanel-visible');
        panel.toggleClass('forecastAlertDetailPanel-visible');
        if (isOpen) {
            $(this).html('<i class="fa-solid fa-chevron-down"></i> View Details');
        } else {
            $(this).html('<i class="fa-solid fa-chevron-up"></i> Hide Details');
        }
    });

    // Favorite star button in forecast view
    _body.on('click', '#forecastFavBtn, .forecastFavBtn', function(e) {
        e.stopPropagation();
        if (_currentLat == null || _currentLon == null) return;
        var isNowFav = _toggleFavorite(_currentName, _currentLat, _currentLon);
        _body.find('#forecastFavBtn, .forecastFavBtn').each(function() {
            if (isNowFav) {
                $(this).addClass('forecastFavBtn-active').attr('title', 'Remove from favorites');
                $(this).find('i').removeClass('fa-regular').addClass('fa-solid');
            } else {
                $(this).removeClass('forecastFavBtn-active').attr('title', 'Add to favorites');
                $(this).find('i').removeClass('fa-solid').addClass('fa-regular');
            }
        });
    });

    // Landing tab switching
    _body.on('click', '.forecastLandingTab', function() {
        var tab = $(this).attr('data-landing-tab');
        _body.find('.forecastLandingTab').removeClass('forecastLandingTab-active');
        $(this).addClass('forecastLandingTab-active');
        _body.find('.forecastLandingPanel').removeClass('forecastLandingPanel-active');
        _body.find('[data-landing-panel="' + tab + '"]').addClass('forecastLandingPanel-active');
    });

    // Click saved row to load forecast
    _body.on('click', '.forecastSavedRow', function() {
        var lat = parseFloat($(this).attr('data-lat'));
        var lon = parseFloat($(this).attr('data-lon'));
        var name = $(this).attr('data-name');
        _searchInput.val(name);
        _loadForecast(lat, lon, name, null, '', '');
    });

    // Remove favorite from landing
    _body.on('click', '.forecastSavedRemoveFav', function(e) {
        e.stopPropagation();
        var lat = parseFloat($(this).attr('data-lat'));
        var lon = parseFloat($(this).attr('data-lon'));
        _removeFavorite(lat, lon);
        $(this).closest('.forecastSavedRow').fadeOut(150, function() {
            $(this).remove();
            if (!_body.find('[data-landing-panel="favorites"] .forecastSavedRow').length) {
                _body.find('[data-landing-panel="favorites"]').html(
                    '<div class="forecastLandingEmpty"><i class="fa-regular fa-star forecastLandingEmptyIcon"></i>' +
                    '<div class="forecastLandingEmptyText">No favorites yet.<br>Search for a location and tap the star to save it.</div></div>'
                );
            }
        });
    });

    // Remove history item from landing
    _body.on('click', '.forecastSavedRemoveHistory', function(e) {
        e.stopPropagation();
        var lat = parseFloat($(this).attr('data-lat'));
        var lon = parseFloat($(this).attr('data-lon'));
        _removeHistory(lat, lon);
        $(this).closest('.forecastSavedRow').fadeOut(150, function() {
            $(this).remove();
            if (!_body.find('[data-landing-panel="recents"] .forecastSavedRow').length) {
                _body.find('[data-landing-panel="recents"]').html(
                    '<div class="forecastLandingEmpty"><i class="fa-solid fa-clock-rotate-left forecastLandingEmptyIcon"></i>' +
                    '<div class="forecastLandingEmptyText">No recent searches.</div></div>'
                );
            }
        });
    });

    $(document).on('click', function(e) {
        if (!$(e.target).closest('.forecastSearchWrap').length) {
            _suggestions.removeClass('forecastSuggestions-visible');
        }
    });
}

// ── Init ──

function init() {
    _buildOverlay();
    $('#armrForecastBtn').on('click', function() { _open(); });
    var shared = _readMyCastShareParams();
    if (shared) _open();
}

module.exports = { init: init };
