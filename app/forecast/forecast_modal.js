var _overlay = null;
var _body = null;
var _searchInput = null;
var _spinner = null;
var _suggestions = null;
var _debounceTimer = null;
var _currentLat = null;
var _currentLon = null;

var NWS_UA = '(StormTrack Pro, https://stormtrack-pro.local)';

// ── Sunrise / sunset (simplified solar calc) ──

function _julianDay(year, month, day) {
    if (month <= 2) { year--; month += 12; }
    var A = Math.floor(year / 100);
    var B = 2 - A + Math.floor(A / 4);
    return Math.floor(365.25 * (year + 4716)) + Math.floor(30.6001 * (month + 1)) + day + B - 1524.5;
}

function _sunTimes(lat, lon, date) {
    var jd = _julianDay(date.getFullYear(), date.getMonth() + 1, date.getDate());
    var n = jd - 2451545.0 + 0.0008;
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

    function jdToDate(jdVal) {
        var millis = (jdVal - 2440587.5) * 86400000;
        return new Date(millis);
    }
    return { sunrise: jdToDate(Jrise), sunset: jdToDate(Jset) };
}

function _formatTime(d) {
    if (!d) return '--';
    var h = d.getHours();
    var m = d.getMinutes();
    var ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
}

// ── Moon phase ──

function _moonPhase(date) {
    var year = date.getFullYear();
    var month = date.getMonth() + 1;
    var day = date.getDate();
    if (month < 3) { year--; month += 12; }
    var A = Math.floor(year / 100);
    var B = Math.floor(A / 4);
    var C = 2 - A + B;
    var E = Math.floor(365.25 * (year + 4716));
    var F = Math.floor(30.6001 * (month + 1));
    var jd = C + day + E + F - 1524.5;
    var daysSinceNew = (jd - 2451550.1) % 29.530588853;
    if (daysSinceNew < 0) daysSinceNew += 29.530588853;
    var phase = daysSinceNew / 29.530588853;

    if (phase < 0.0625) return { name: 'New Moon', icon: 'fa-moon' };
    if (phase < 0.1875) return { name: 'Waxing Crescent', icon: 'fa-moon' };
    if (phase < 0.3125) return { name: 'First Quarter', icon: 'fa-circle-half-stroke' };
    if (phase < 0.4375) return { name: 'Waxing Gibbous', icon: 'fa-moon' };
    if (phase < 0.5625) return { name: 'Full Moon', icon: 'fa-circle' };
    if (phase < 0.6875) return { name: 'Waning Gibbous', icon: 'fa-moon' };
    if (phase < 0.8125) return { name: 'Last Quarter', icon: 'fa-circle-half-stroke' };
    if (phase < 0.9375) return { name: 'Waning Crescent', icon: 'fa-moon' };
    return { name: 'New Moon', icon: 'fa-moon' };
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

// ── Color for temperature ──

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

// ── Geocoding via Nominatim ──

function _geocode(query, cb) {
    var url = 'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(query) +
        '&format=json&countrycodes=us&limit=5&addressdetails=1';
    fetch(url, { headers: { 'User-Agent': NWS_UA } })
        .then(function(r) { return r.json(); })
        .then(function(data) { cb(null, data); })
        .catch(function(err) { cb(err, null); });
}

function _buildDisplayName(item) {
    var addr = item.address || {};
    var city = addr.city || addr.town || addr.village || addr.hamlet || addr.county || '';
    var state = addr.state || '';
    if (city && state) return city + ', ' + state;
    if (item.display_name) return item.display_name.split(',').slice(0, 3).join(',');
    return item.display_name || 'Unknown';
}

// ── NWS fetch helpers ──

function _nwsFetch(url) {
    var headers = new Headers();
    headers.append('User-Agent', NWS_UA);
    headers.append('Accept', 'application/geo+json');
    return fetch(url, { headers: headers }).then(function(r) {
        if (!r.ok) throw new Error('NWS request failed: ' + r.status);
        return r.json();
    });
}

function _fetchAllData(lat, lon, cb) {
    var pointsUrl = 'https://api.weather.gov/points/' + lat.toFixed(4) + ',' + lon.toFixed(4);

    _nwsFetch(pointsUrl).then(function(points) {
        var props = points.properties;
        var forecastUrl = props.forecast;
        var stationsUrl = props.observationStations;
        var alertsUrl = 'https://api.weather.gov/alerts/active?point=' + lat.toFixed(4) + ',' + lon.toFixed(4);
        var locationName = (props.relativeLocation && props.relativeLocation.properties)
            ? props.relativeLocation.properties.city + ', ' + props.relativeLocation.properties.state
            : '';

        Promise.all([
            _nwsFetch(forecastUrl),
            _nwsFetch(stationsUrl).then(function(s) {
                var first = s.features && s.features[0];
                if (!first) return null;
                var stationId = first.properties.stationIdentifier;
                return _nwsFetch('https://api.weather.gov/stations/' + stationId + '/observations/latest');
            }).catch(function() { return null; }),
            _nwsFetch(alertsUrl).catch(function() { return { features: [] }; })
        ]).then(function(results) {
            cb(null, {
                forecast: results[0],
                observation: results[1],
                alerts: results[2],
                locationName: locationName
            });
        }).catch(function(err) { cb(err, null); });
    }).catch(function(err) { cb(err, null); });
}

// ── Render helpers ──

function _renderCurrentConditions(observation, lat, lon) {
    var obs = (observation && observation.properties) || {};
    var tempC = obs.temperature && obs.temperature.value;
    var tempF = tempC != null ? Math.round(tempC * 9 / 5 + 32) : null;
    var windSpeedKmh = obs.windSpeed && obs.windSpeed.value;
    var windMph = windSpeedKmh != null ? Math.round(windSpeedKmh * 0.621371) : null;
    var windDir = obs.windDirection && obs.windDirection.value;
    var windCardinal = _degreesToCardinal(windDir);
    var humidity = obs.relativeHumidity && obs.relativeHumidity.value;
    var humidityStr = humidity != null ? Math.round(humidity) + '%' : '--';
    var description = obs.textDescription || '--';
    var heatIdxC = obs.heatIndex && obs.heatIndex.value;
    var windChillC = obs.windChill && obs.windChill.value;
    var feelsLikeC = heatIdxC != null ? heatIdxC : (windChillC != null ? windChillC : tempC);
    var feelsLikeF = feelsLikeC != null ? Math.round(feelsLikeC * 9 / 5 + 32) : null;

    var now = new Date();
    var sun = _sunTimes(lat, lon, now);
    var moon = _moonPhase(now);

    var html = '<div class="forecastCurrent">';
    html += '<div class="forecastSectionLabel">Current Conditions</div>';
    html += '<div class="forecastCurrentGrid">';

    html += '<div class="forecastCard">' +
        '<span class="forecastCardLabel">Temperature</span>' +
        '<span class="forecastCardTemp" style="color:' + _tempColor(tempF) + '">' + (tempF != null ? tempF + '°F' : '--') + '</span>' +
        (feelsLikeF != null ? '<span class="forecastCardSub">Feels like ' + feelsLikeF + '°F</span>' : '') +
        '</div>';

    html += '<div class="forecastCard">' +
        '<span class="forecastCardLabel"><i class="fa-solid ' + _weatherIcon(description, true) + ' forecastCardIcon"></i> Condition</span>' +
        '<span class="forecastCardValue">' + description + '</span>' +
        '</div>';

    html += '<div class="forecastCard">' +
        '<span class="forecastCardLabel"><i class="fa-solid fa-wind forecastCardIcon"></i> Wind</span>' +
        '<span class="forecastCardValue">' + (windMph != null ? windMph + ' mph' : '--') + '</span>' +
        (windCardinal ? '<span class="forecastCardSub">' + windCardinal + '</span>' : '') +
        '</div>';

    html += '<div class="forecastCard">' +
        '<span class="forecastCardLabel"><i class="fa-solid fa-droplet forecastCardIcon"></i> Humidity</span>' +
        '<span class="forecastCardValue">' + humidityStr + '</span>' +
        '</div>';

    html += '<div class="forecastCard">' +
        '<span class="forecastCardLabel"><i class="fa-solid fa-sun forecastCardIcon"></i> Sunrise</span>' +
        '<span class="forecastCardValue">' + (sun ? _formatTime(sun.sunrise) : '--') + '</span>' +
        '</div>';

    html += '<div class="forecastCard">' +
        '<span class="forecastCardLabel"><i class="fa-solid fa-moon forecastCardIcon"></i> Sunset</span>' +
        '<span class="forecastCardValue">' + (sun ? _formatTime(sun.sunset) : '--') + '</span>' +
        '</div>';

    html += '<div class="forecastCard">' +
        '<span class="forecastCardLabel"><i class="fa-solid ' + moon.icon + ' forecastCardIcon"></i> Moon</span>' +
        '<span class="forecastCardValue">' + moon.name + '</span>' +
        '</div>';

    html += '</div></div>';
    return html;
}

function _degreesToCardinal(deg) {
    if (deg == null) return '';
    var dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
}

function _renderAlerts(alertsData) {
    var features = (alertsData && alertsData.features) || [];
    if (!features.length) return '';
    var html = '<div class="forecastAlertBanner"><i class="fa-solid fa-triangle-exclamation"></i><div class="forecastAlertBannerList">';
    for (var i = 0; i < features.length; i++) {
        var event = features[i].properties.event || 'Unknown Alert';
        html += '<div class="forecastAlertBannerItem">' + event + '</div>';
    }
    html += '</div></div>';
    return html;
}

function _renderForecast(forecastData) {
    var periods = (forecastData && forecastData.properties && forecastData.properties.periods) || [];
    if (!periods.length) return '';

    var days = [];
    for (var i = 0; i < periods.length; i++) {
        var p = periods[i];
        if (p.isDaytime) {
            var night = (i + 1 < periods.length && !periods[i + 1].isDaytime) ? periods[i + 1] : null;
            days.push({ day: p, night: night });
        }
    }

    var html = '<div class="forecastDays">';
    html += '<div class="forecastSectionLabel">7 Day Forecast</div>';
    html += '<div class="forecastDayList">';

    for (var d = 0; d < days.length; d++) {
        var entry = days[d];
        var dayP = entry.day;
        var nightP = entry.night;
        var dt = new Date(dayP.startTime);
        var dayName = d === 0 ? 'Today' : dt.toLocaleDateString('en-US', { weekday: 'short' });
        var icon = _weatherIcon(dayP.shortForecast, true);
        var high = dayP.temperature;
        var low = nightP ? nightP.temperature : '--';
        var precip = dayP.probabilityOfPrecipitation && dayP.probabilityOfPrecipitation.value;
        var precipStr = precip != null && precip > 0 ? precip + '%' : '';

        html += '<div class="forecastDayRow">' +
            '<span class="forecastDayName">' + dayName + '</span>' +
            '<span class="forecastDayIcon" style="color:' + _tempColor(high) + '"><i class="fa-solid ' + icon + '"></i></span>' +
            '<span class="forecastDayTemps"><span class="forecastDayHigh" style="color:' + _tempColor(high) + '">' + high + '°</span><span class="forecastDayLow">' + low + '°</span></span>' +
            '<span class="forecastDayDesc">' + dayP.shortForecast + '</span>' +
            (precipStr ? '<span class="forecastDayPrecip"><i class="fa-solid fa-droplet"></i> ' + precipStr + '</span>' : '<span class="forecastDayPrecip"></span>') +
            '</div>';
    }

    html += '</div></div>';
    return html;
}

// ── Load location data ──

function _loadForecast(lat, lon, displayName) {
    _currentLat = lat;
    _currentLon = lon;

    _body.html(
        '<div class="forecastLoading">' +
        '<div class="forecastLoadingSpinner"></div>' +
        '<div class="forecastLoadingText">Loading forecast...</div>' +
        '</div>'
    );

    _fetchAllData(lat, lon, function(err, data) {
        if (err) {
            _body.html(
                '<div class="forecastError"><i class="fa-solid fa-circle-exclamation"></i> ' +
                'Failed to load forecast. Please try another location.</div>'
            );
            return;
        }

        var name = displayName || data.locationName || 'Unknown Location';
        var html = '';

        html += '<div class="forecastLocation">' +
            '<i class="fa-solid fa-location-dot forecastLocationIcon"></i>' +
            '<span class="forecastLocationName">' + name + '</span>' +
            '<span class="forecastLocationCoords">' + lat.toFixed(2) + ', ' + lon.toFixed(2) + '</span>' +
            '</div>';

        html += _renderAlerts(data.alerts);
        html += _renderCurrentConditions(data.observation, lat, lon);
        html += _renderForecast(data.forecast);

        _body.html(html);
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
                html += '<div class="forecastSuggestionItem" data-lat="' + r.lat + '" data-lon="' + r.lon + '" data-name="' + _buildDisplayName(r).replace(/"/g, '&quot;') + '">' +
                    _buildDisplayName(r) + '</div>';
            }
            _suggestions.html(html).addClass('forecastSuggestions-visible');
        });
    }, 350);
}

function _onSuggestionClick(e) {
    var $item = $(e.target).closest('.forecastSuggestionItem');
    if (!$item.length) return;
    var lat = parseFloat($item.attr('data-lat'));
    var lon = parseFloat($item.attr('data-lon'));
    var name = $item.attr('data-name');
    _searchInput.val(name);
    _suggestions.removeClass('forecastSuggestions-visible');
    _loadForecast(lat, lon, name);
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
                _body.html('<div class="forecastError"><i class="fa-solid fa-circle-exclamation"></i> No results found. Try a different search.</div>');
                return;
            }
            var r = results[0];
            var name = _buildDisplayName(r);
            _searchInput.val(name);
            _loadForecast(parseFloat(r.lat), parseFloat(r.lon), name);
        });
    }
}

// ── Open / close ──

function _open() {
    _overlay.addClass('forecastOverlay-visible');
    _searchInput.val('');
    _suggestions.removeClass('forecastSuggestions-visible');
    _body.html(
        '<div class="forecastEmpty">' +
        '<i class="fa-solid fa-cloud-sun forecastEmptyIcon"></i>' +
        '<div class="forecastEmptyText">Search for a city, state, or zip code<br>to view the 7 day forecast.</div>' +
        '</div>'
    );
    setTimeout(function() { _searchInput.focus(); }, 100);
}

function _close() {
    _overlay.removeClass('forecastOverlay-visible');
}

// ── Build DOM ──

function _buildOverlay() {
    var html =
        '<div class="forecastOverlay" id="forecastOverlay">' +
            '<div class="forecastModal">' +
                '<div class="forecastHeader">' +
                    '<div class="forecastHeaderLeft">' +
                        '<span class="forecastHeaderTitle">7 Day Forecast</span>' +
                        '<span class="forecastHeaderSub">National Weather Service</span>' +
                    '</div>' +
                    '<button type="button" class="forecastCloseBtn" id="forecastCloseBtn" aria-label="Close"><i class="fa fa-xmark"></i></button>' +
                '</div>' +
                '<div class="forecastSearch">' +
                    '<i class="fa-solid fa-magnifying-glass forecastSearchIcon"></i>' +
                    '<div class="forecastSearchWrap" style="flex:1;position:relative;">' +
                        '<input type="text" class="forecastSearchInput" id="forecastSearchInput" placeholder="Search by city, state, or zip code..." autocomplete="off">' +
                        '<div class="forecastSuggestions" id="forecastSuggestions"></div>' +
                    '</div>' +
                    '<div class="forecastSearchSpinner" id="forecastSearchSpinner"></div>' +
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

    $('#forecastCloseBtn').on('click', _close);
    _overlay.on('click', function(e) {
        if ($(e.target).hasClass('forecastOverlay')) _close();
    });
    _searchInput.on('input', _onSearchInput);
    _searchInput.on('keydown', _onSearchKeydown);
    _suggestions.on('click', _onSuggestionClick);

    $(document).on('click', function(e) {
        if (!$(e.target).closest('.forecastSearchWrap').length) {
            _suggestions.removeClass('forecastSuggestions-visible');
        }
    });
}

// ── Init ──

function init() {
    _buildOverlay();
    $('#armrForecastBtn').on('click', function() {
        _open();
    });
}

module.exports = { init: init };
