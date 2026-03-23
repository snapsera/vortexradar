var map = require('../core/map/map');
var lightning = require('../lightning/lightning');
var settings_store = require('../core/menu/settings_store');
var notification = require('../core/notifications/notification_bubble');
var get_nexrad_location = require('../radar/libnexrad/nexrad_locations').get_nexrad_location;

var _open = false;
var _history = [];
var _historyIndex = -1;

var COMMANDS = {
    shine: {
        description: 'Trigger warning counter shine effect on SVR, TOR, or SPC row',
        usage: 'shine [svr|tor|spc]',
        run: _cmd_shine
    },
    lightning: {
        description: 'Simulate lightning strikes around the current station',
        usage: 'lightning [count]',
        run: _cmd_lightning
    },
    tornado: {
        description: 'Inject a fake Tornado Warning into the alerts layer',
        usage: 'tornado',
        run: _cmd_tornado
    },
    'save-defaults': {
        description: 'Save current settings as the site-wide defaults JSON',
        usage: 'save-defaults',
        run: _cmd_save_defaults
    },
    help: {
        description: 'List available commands',
        usage: 'help',
        run: _cmd_help
    },
    clear: {
        description: 'Clear the console output',
        usage: 'clear',
        run: _cmd_clear
    }
};

function _log(html, cls) {
    var body = document.getElementById('devConsoleBody');
    if (!body) return;
    var line = document.createElement('div');
    line.className = 'devConsoleLine' + (cls ? ' devConsoleLine--' + cls : '');
    line.innerHTML = html;
    body.appendChild(line);
    body.scrollTop = body.scrollHeight;
}

function _cmd_help() {
    var lines = ['<span class="devConsoleAccent">Available commands:</span>'];
    var keys = Object.keys(COMMANDS);
    for (var i = 0; i < keys.length; i++) {
        var c = COMMANDS[keys[i]];
        lines.push(
            '<span class="devConsoleCmd">' + c.usage + '</span>' +
            '<span class="devConsoleMuted"> — ' + c.description + '</span>'
        );
    }
    _log(lines.join('<br>'));
}

function _cmd_clear() {
    var body = document.getElementById('devConsoleBody');
    if (body) body.innerHTML = '';
}

function _cmd_shine(args) {
    var target = (args[0] || 'all').toLowerCase();
    var selectors = [];
    if (target === 'svr' || target === 'all') selectors.push('.warningCounterRow-svr');
    if (target === 'tor' || target === 'all') selectors.push('.warningCounterRow-tor');
    if (target === 'spc' || target === 'all') selectors.push('#warningCounterSpcRow');

    if (!selectors.length) {
        _log('Unknown target: ' + target + '. Use svr, tor, spc, or all.', 'error');
        return;
    }

    var triggered = 0;
    for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i]);
        if (el) {
            el.classList.remove('warningCounterRow-shine');
            void el.offsetWidth;
            el.classList.add('warningCounterRow-shine');
            triggered++;
        }
    }

    if (triggered) {
        _log('Shine triggered on ' + (target === 'all' ? 'all rows' : target.toUpperCase()), 'success');
    } else {
        _log('Warning counter not visible. Enable it in settings first.', 'warn');
    }
}

function _cmd_lightning(args) {
    var count = parseInt(args[0], 10) || 5;
    if (count < 1) count = 1;
    if (count > 50) count = 50;

    var station = window.stormTrackData && window.stormTrackData.currentStation;
    if (!station) {
        _log('No station selected — select a radar site first.', 'error');
        return;
    }

    var loc = get_nexrad_location(station);
    if (!loc || (loc[0] === 0 && loc[1] === 0)) {
        _log('Cannot determine station location for ' + station, 'error');
        return;
    }

    var SOURCE_ID = 'lightningSource';
    if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
    }
    if (!map.getLayer('lightningGlow')) {
        map.addLayer({
            id: 'lightningGlow',
            type: 'circle',
            source: SOURCE_ID,
            paint: {
                'circle-radius': ['get', 'gr'],
                'circle-color': '#dde4ff',
                'circle-opacity': ['get', 'go'],
                'circle-blur': 1
            }
        });
    }
    if (!map.getLayer('lightningCore')) {
        map.addLayer({
            id: 'lightningCore',
            type: 'circle',
            source: SOURCE_ID,
            paint: {
                'circle-radius': ['get', 'cr'],
                'circle-color': '#ffffff',
                'circle-opacity': ['get', 'co'],
                'circle-blur': 0.6
            }
        });
    }

    var stationLat = loc[0];
    var stationLon = loc[1];
    var strikes = [];
    for (var i = 0; i < count; i++) {
        var angle = Math.random() * Math.PI * 2;
        var dist = Math.random() * 1.5;
        strikes.push({
            lt: stationLat + dist * Math.cos(angle),
            ln: stationLon + dist * Math.sin(angle),
            t: Date.now() + i * 120
        });
    }

    var LIFETIME = 4000;
    var INTERVAL = 60;

    function animate() {
        var now = Date.now();
        var alive = strikes.filter(function(s) { return (now - s.t) < LIFETIME; });
        if (!alive.length) {
            var src = map.getSource(SOURCE_ID);
            if (src) src.setData({ type: 'FeatureCollection', features: [] });
            return;
        }
        var features = [];
        for (var j = 0; j < alive.length; j++) {
            var s = alive[j];
            var age = now - s.t;
            if (age < 0) age = 0;
            var t = age / LIFETIME;
            var intensity = age < 80 ? 1.0 : Math.exp(-3.5 * t);
            if (intensity < 0.01) continue;
            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [s.ln, s.lt] },
                properties: {
                    co: intensity * 0.7,
                    go: intensity * 0.35,
                    cr: 3 + intensity * 3,
                    gr: 10 + intensity * 12
                }
            });
        }
        var src = map.getSource(SOURCE_ID);
        if (src) src.setData({ type: 'FeatureCollection', features: features });
        setTimeout(animate, INTERVAL);
    }

    animate();
    _log('Simulated <strong>' + count + '</strong> lightning strike' + (count > 1 ? 's' : '') + ' near ' + station, 'success');
}

function _cmd_tornado() {
    var station = window.stormTrackData && window.stormTrackData.currentStation;
    if (!station) {
        _log('No station selected — select a radar site first.', 'error');
        return;
    }

    var loc = get_nexrad_location(station);
    if (!loc || (loc[0] === 0 && loc[1] === 0)) {
        _log('Cannot determine station location for ' + station, 'error');
        return;
    }

    var lat = loc[0];
    var lon = loc[1];
    var d = 0.3;
    var coords = [[
        [lon - d, lat - d],
        [lon + d, lat - d],
        [lon + d, lat + d],
        [lon - d, lat + d],
        [lon - d, lat - d]
    ]];

    var now = new Date();
    var expires = new Date(now.getTime() + 45 * 60 * 1000);

    var feature = {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: coords },
        properties: {
            id: 'dev-tornado-' + Date.now(),
            event: 'Tornado Warning',
            headline: '[DEV] Tornado Warning near ' + station,
            description: 'This is a simulated Tornado Warning issued from the developer console for testing purposes.',
            sent: now.toISOString(),
            effective: now.toISOString(),
            expires: expires.toISOString(),
            severity: 'Extreme',
            urgency: 'Immediate',
            certainty: 'Observed',
            senderName: 'StormTrack Dev Console',
            areaDesc: 'Near ' + station,
            blinking: true,
            _devtest: true
        }
    };

    if (!window.stormTrackData.testAlertFeatures) {
        window.stormTrackData.testAlertFeatures = [];
    }
    window.stormTrackData.testAlertFeatures.push(feature);

    var plot_alerts = require('../alerts/plot_alerts');
    var alertsData = window.stormTrackData.alerts_data;
    if (alertsData) {
        var clone = JSON.parse(JSON.stringify(alertsData));
        plot_alerts(clone);
    }

    $(document).trigger('alertsDataLoaded');

    _log('Injected <strong>Tornado Warning</strong> near ' + station + ' (expires in 45 min)', 'success');
    notification.notify('DEV: Tornado Warning injected', { icon: 'fa fa-tornado', level: 'danger' });
}

function _cmd_save_defaults() {
    var settings = settings_store.get_settings_from_dom();

    _log('Saving current settings as site defaults...', 'info');

    fetch('/api/save-defaults', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
    })
    .then(function(res) {
        if (!res.ok) throw new Error('Server returned ' + res.status);
        return res.json();
    })
    .then(function(data) {
        _log('Site defaults saved successfully to <span class="devConsoleCmd">site_defaults.json</span>', 'success');
        notification.notify('Site defaults saved', { icon: 'fa fa-floppy-disk', level: 'success' });
    })
    .catch(function(err) {
        _log('Failed to save defaults: ' + err.message, 'error');
    });
}

function _execute(input) {
    input = input.trim();
    if (!input) return;

    _history.push(input);
    _historyIndex = _history.length;

    _log('<span class="devConsolePrompt">&gt;</span> ' + _escapeHtml(input), 'input');

    var parts = input.split(/\s+/);
    var cmd = parts[0].toLowerCase();
    var args = parts.slice(1);

    if (COMMANDS[cmd]) {
        COMMANDS[cmd].run(args);
    } else {
        _log('Unknown command: <span class="devConsoleCmd">' + _escapeHtml(cmd) + '</span>. Type <span class="devConsoleCmd">help</span> for a list.', 'error');
    }
}

function _escapeHtml(text) {
    var d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

function toggle() {
    _open = !_open;
    var panel = document.getElementById('devConsolePanel');
    if (!panel) return;
    if (_open) {
        panel.classList.add('devConsolePanel--open');
        var input = document.getElementById('devConsoleInput');
        if (input) setTimeout(function() { input.focus(); }, 250);
    } else {
        panel.classList.remove('devConsolePanel--open');
    }
}

function open() {
    if (_open) return;
    toggle();
}

function close() {
    if (!_open) return;
    toggle();
}

function init() {
    var input = document.getElementById('devConsoleInput');
    if (!input) return;

    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            _execute(input.value);
            input.value = '';
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (_historyIndex > 0) {
                _historyIndex--;
                input.value = _history[_historyIndex];
            }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (_historyIndex < _history.length - 1) {
                _historyIndex++;
                input.value = _history[_historyIndex];
            } else {
                _historyIndex = _history.length;
                input.value = '';
            }
        } else if (e.key === 'Escape') {
            close();
        }
    });

    var closeBtn = document.getElementById('devConsoleClose');
    if (closeBtn) closeBtn.addEventListener('click', close);

    document.getElementById('devConsoleOpenBtn').addEventListener('click', function() {
        toggle();
        require('../core/menu/stormTrackProMenu').hideARMwindow();
    });

    _log('<span class="devConsoleAccent">StormTrack Developer Console</span> — type <span class="devConsoleCmd">help</span> for commands', 'info');
}

module.exports = { init: init, toggle: toggle, open: open, close: close };
