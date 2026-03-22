const CHANGELOG = [
    {
        date: '2026-03-19',
        entries: [
            { time: '8:20 PM', change: 'Added Change Log UI with day tabs accessible from the menu' },
            { time: '8:20 PM', change: 'Fixed menu toggle arrow direction — now points left/right instead of up/down' },
            { time: '8:20 PM', change: 'Fixed radar scan history to accumulate across multiple days (up to 100 scans)' },
            { time: '8:35 PM', change: 'Fixed map not extending to the bottom of the screen — bodyDiv now fills viewport' },
            { time: '8:35 PM', change: 'Moved floating footer bar up significantly from the bottom edge (55px)' },
            { time: '8:55 PM', change: 'Restored Ctrl+Shift+R (force reload) and Ctrl+Shift+I (dev tools) keyboard shortcuts' },
            { time: '9:00 PM', change: 'Fixed JS in display_file_info.js overriding footer position and map bottom margin on radar load' },
            { time: '9:05 PM', change: 'Adjusted footer position from 55px to 35px from bottom' },
        ]
    }
];

function _format_display_date(date_str) {
    const d = new Date(date_str + 'T12:00:00');
    const options = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
    return d.toLocaleDateString('en-US', options);
}

function _short_tab_label(date_str) {
    const d = new Date(date_str + 'T12:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function _build_overlay() {
    var overlay = document.createElement('div');
    overlay.id = 'changelogOverlay';
    overlay.className = 'changelog-overlay';

    var modal = document.createElement('div');
    modal.className = 'changelog-modal';

    var header = document.createElement('div');
    header.className = 'changelog-header';
    header.innerHTML =
        '<div class="changelog-header-left">' +
            '<i class="fa fa-clock-rotate-left changelog-header-icon"></i>' +
            '<span class="changelog-header-title">Change Log</span>' +
        '</div>' +
        '<button type="button" class="changelog-close-btn" aria-label="Close"><i class="fa fa-xmark"></i></button>';

    var tabs = document.createElement('div');
    tabs.className = 'changelog-tabs';

    var body = document.createElement('div');
    body.className = 'changelog-body';

    CHANGELOG.forEach(function(day, idx) {
        var tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'changelog-tab' + (idx === 0 ? ' changelog-tab-active' : '');
        tab.textContent = _short_tab_label(day.date);
        tab.setAttribute('data-idx', idx);
        tabs.appendChild(tab);
    });

    if (CHANGELOG.length === 0) {
        body.innerHTML = '<div class="changelog-empty">No changes recorded yet.</div>';
    } else {
        _render_day(body, CHANGELOG[0]);
    }

    modal.appendChild(header);
    modal.appendChild(tabs);
    modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    header.querySelector('.changelog-close-btn').addEventListener('click', _close);
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) _close();
    });

    tabs.addEventListener('click', function(e) {
        var btn = e.target.closest('.changelog-tab');
        if (!btn) return;
        var idx = parseInt(btn.getAttribute('data-idx'));
        tabs.querySelectorAll('.changelog-tab').forEach(function(t) { t.classList.remove('changelog-tab-active'); });
        btn.classList.add('changelog-tab-active');
        body.innerHTML = '';
        _render_day(body, CHANGELOG[idx]);
    });

    return overlay;
}

function _render_day(container, day) {
    var dateHeader = document.createElement('div');
    dateHeader.className = 'changelog-date-header';
    dateHeader.textContent = _format_display_date(day.date);
    container.appendChild(dateHeader);

    var groups = {};
    day.entries.forEach(function(entry) {
        var key = entry.time || 'Unknown';
        if (!groups[key]) groups[key] = [];
        groups[key].push(entry.change);
    });

    Object.keys(groups).forEach(function(time) {
        var group = document.createElement('div');
        group.className = 'changelog-group';

        var timeLabel = document.createElement('div');
        timeLabel.className = 'changelog-time';
        timeLabel.innerHTML = '<i class="fa fa-clock"></i> ' + time;
        group.appendChild(timeLabel);

        var list = document.createElement('ul');
        list.className = 'changelog-list';
        groups[time].forEach(function(change) {
            var li = document.createElement('li');
            li.className = 'changelog-item';
            li.textContent = change;
            list.appendChild(li);
        });
        group.appendChild(list);
        container.appendChild(group);
    });
}

function _open() {
    var existing = document.getElementById('changelogOverlay');
    if (existing) existing.remove();
    var overlay = _build_overlay();
    requestAnimationFrame(function() {
        overlay.classList.add('changelog-overlay-visible');
    });
}

function _close() {
    var overlay = document.getElementById('changelogOverlay');
    if (!overlay) return;
    overlay.classList.remove('changelog-overlay-visible');
    setTimeout(function() { overlay.remove(); }, 200);
}

$('#armrChangelogBtn').on('click', function() {
    _open();
});

module.exports = { open: _open, close: _close, CHANGELOG: CHANGELOG };
