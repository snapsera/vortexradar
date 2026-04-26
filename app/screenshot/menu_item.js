const notificationBubble = require('../core/notifications/notification_bubble');
const map = require('../core/map/map');

const div_elem = '#screenshotMenuItemDiv';
const icon_elem = '#screenshotMenuItemIcon';

var _active = false;
var _selectMode = false;
var _overlay = null;
var _selection = null;
var _actionBar = null;
var _modeToolbar = null;
var _startX = 0;
var _startY = 0;
var _dragging = false;
var _hasSelection = false;

// ---------- mode picker toolbar (slide-out like draw tool) ----------

function _build_mode_toolbar() {
    return '<div id="screenshotModeToolbar" class="screenshotModeToolbar">' +
        '<div class="screenshotModeToolbarInner">' +
            '<button type="button" id="ssSelectAreaBtn" class="drawToolBtn" title="Select Area">' +
                '<i class="fa-solid fa-circle"></i>' +
            '</button>' +
            '<button type="button" id="ssFullScreenBtn" class="drawToolBtn" title="Full Screen">' +
                '<i class="fa-solid fa-expand"></i>' +
            '</button>' +
            '<div class="drawToolDivider"></div>' +
            '<button type="button" id="ssCloseBtn" class="drawToolBtn drawToolBtn-close" title="Close">' +
                '<i class="fa-solid fa-xmark"></i>' +
            '</button>' +
        '</div>' +
    '</div>';
}

function _enter_screenshot_mode() {
    if (_active) return;
    _active = true;

    $(icon_elem).addClass('menu_item_selected').removeClass('menu_item_not_selected');
    $('#floatingToolbar').addClass('screenshotMode-hidden');

    $('body').append(_build_mode_toolbar());
    var $tb = $('#screenshotModeToolbar');
    requestAnimationFrame(function () { $tb.addClass('screenshotModeToolbar-visible'); });

    $('#ssSelectAreaBtn').on('click', function () { _enter_select_mode(); });
    $('#ssFullScreenBtn').on('click', function () { _capture_full_screen(); });
    $('#ssCloseBtn').on('click', function () { _exit_screenshot_mode(); });

    document.addEventListener('keydown', _on_keydown);
}

function _exit_screenshot_mode() {
    if (!_active) return;
    _active = false;
    _selectMode = false;
    _dragging = false;
    _hasSelection = false;

    $(icon_elem).removeClass('menu_item_selected').addClass('menu_item_not_selected');
    $('#floatingToolbar').removeClass('screenshotMode-hidden');

    if (_overlay) { _overlay.remove(); _overlay = null; }
    if (_selection) { _selection.remove(); _selection = null; }
    if (_actionBar) { _actionBar.remove(); _actionBar = null; }

    var $tb = $('#screenshotModeToolbar');
    $tb.removeClass('screenshotModeToolbar-visible').addClass('screenshotModeToolbar-closing');
    setTimeout(function () { $tb.remove(); }, 250);
    _modeToolbar = null;

    document.removeEventListener('keydown', _on_keydown);
}

// ---------- select-area sub-mode ----------

function _enter_select_mode() {
    if (_selectMode) return;
    _selectMode = true;

    $('#ssSelectAreaBtn').addClass('drawToolBtn-active');

    _overlay = document.createElement('div');
    _overlay.id = 'screenshotOverlay';
    _overlay.className = 'screenshotOverlay';
    document.body.appendChild(_overlay);

    _selection = document.createElement('div');
    _selection.id = 'screenshotSelection';
    _selection.className = 'screenshotSelection';
    _selection.style.display = 'none';
    document.body.appendChild(_selection);

    _overlay.addEventListener('pointerdown', _on_pointerdown);
    _overlay.addEventListener('pointermove', _on_pointermove);
    _overlay.addEventListener('pointerup', _on_pointerup);
    _overlay.addEventListener('contextmenu', _on_contextmenu);
}

function _exit_select_mode() {
    _selectMode = false;
    _dragging = false;
    _hasSelection = false;

    $('#ssSelectAreaBtn').removeClass('drawToolBtn-active');

    if (_overlay) { _overlay.remove(); _overlay = null; }
    if (_selection) { _selection.remove(); _selection = null; }
    if (_actionBar) { _actionBar.remove(); _actionBar = null; }
}

function _clear_selection() {
    _hasSelection = false;
    if (_selection) { _selection.style.display = 'none'; }
    if (_actionBar) { _actionBar.remove(); _actionBar = null; }
}

function _on_contextmenu(e) {
    e.preventDefault();
    if (_hasSelection) {
        _clear_selection();
    } else {
        _exit_select_mode();
    }
}

function _on_keydown(e) {
    if (e.key === 'Escape') _exit_screenshot_mode();
}

function _on_pointerdown(e) {
    if (e.button !== 0) return;
    _dragging = true;
    _startX = e.clientX;
    _startY = e.clientY;

    if (_actionBar) { _actionBar.remove(); _actionBar = null; }

    _selection.style.display = 'block';
    _selection.style.left = _startX + 'px';
    _selection.style.top = _startY + 'px';
    _selection.style.width = '0px';
    _selection.style.height = '0px';

    _overlay.setPointerCapture(e.pointerId);
}

function _on_pointermove(e) {
    if (!_dragging) return;

    var x = Math.min(e.clientX, _startX);
    var y = Math.min(e.clientY, _startY);
    var w = Math.abs(e.clientX - _startX);
    var h = Math.abs(e.clientY - _startY);

    _selection.style.left = x + 'px';
    _selection.style.top = y + 'px';
    _selection.style.width = w + 'px';
    _selection.style.height = h + 'px';
}

function _on_pointerup(e) {
    if (!_dragging) return;
    _dragging = false;

    var x = Math.min(e.clientX, _startX);
    var y = Math.min(e.clientY, _startY);
    var w = Math.abs(e.clientX - _startX);
    var h = Math.abs(e.clientY - _startY);

    if (w < 10 || h < 10) {
        _selection.style.display = 'none';
        return;
    }

    _hasSelection = true;
    _show_action_bar(x, y, w, h);
}

// ---------- action bar (save / open folder / cancel) ----------

function _show_action_bar(x, y, w, h) {
    if (_actionBar) _actionBar.remove();

    _actionBar = document.createElement('div');
    _actionBar.className = 'screenshotToolbar';

    var saveBtn = document.createElement('button');
    saveBtn.className = 'screenshotToolbarBtn screenshotToolbarBtn-save';
    saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save';
    saveBtn.addEventListener('click', function () { _save_area(x, y, w, h); });

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'screenshotToolbarBtn screenshotToolbarBtn-cancel';
    cancelBtn.innerHTML = '<i class="fa-solid fa-xmark"></i> Cancel';
    cancelBtn.addEventListener('click', function () { _clear_selection(); });

    _actionBar.appendChild(saveBtn);
    _actionBar.appendChild(cancelBtn);
    document.body.appendChild(_actionBar);

    var tbW = _actionBar.offsetWidth;
    var tbH = _actionBar.offsetHeight;
    var margin = 10;

    var tbLeft = x + (w / 2) - (tbW / 2);
    var tbTop;

    if (y + h + margin + tbH <= window.innerHeight) {
        tbTop = y + h + margin;
    } else if (y - tbH - margin >= 0) {
        tbTop = y - tbH - margin;
    } else {
        tbTop = y + h - tbH - margin;
    }

    tbLeft = Math.max(8, Math.min(tbLeft, window.innerWidth - tbW - 8));
    tbTop = Math.max(8, Math.min(tbTop, window.innerHeight - tbH - 8));

    _actionBar.style.left = tbLeft + 'px';
    _actionBar.style.top = tbTop + 'px';
}

// ---------- watermark ----------

function _add_watermark(base64, callback) {
    var img = new Image();
    img.onload = function () {
        var canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        var icon = new Image();
        icon.onload = function () {
            var scale = Math.max(1, img.height / 600);
            var iconSize = Math.round(20 * scale);
            var fontSize = Math.round(13 * scale);
            var pad = Math.round(8 * scale);
            var gap = Math.round(6 * scale);
            var margin = Math.round(10 * scale);
            var radius = Math.round(6 * scale);
            var text = 'VortexRadar';

            ctx.font = '600 ' + fontSize + 'px Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
            var textW = ctx.measureText(text).width;

            var wmW = pad + iconSize + gap + textW + pad;
            var wmH = pad + iconSize + pad;
            var wmX = canvas.width - wmW - margin;
            var wmY = canvas.height - wmH - margin;

            ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
            ctx.beginPath();
            ctx.roundRect(wmX, wmY, wmW, wmH, radius);
            ctx.fill();

            ctx.globalAlpha = 0.5;
            ctx.drawImage(icon, wmX + pad, wmY + pad, iconSize, iconSize);
            ctx.globalAlpha = 1.0;

            ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, wmX + pad + iconSize + gap, wmY + wmH / 2);

            var dataUrl = canvas.toDataURL('image/png');
            callback(dataUrl.split(',')[1]);
        };
        icon.onerror = function () {
            var dataUrl = canvas.toDataURL('image/png');
            callback(dataUrl.split(',')[1]);
        };
        icon.src = '/images/vortexicon.svg';
    };
    img.src = 'data:image/png;base64,' + base64;
}

// ---------- capture helpers ----------

function _capture_from_map(x, y, w, h) {
    var mapCanvas = map.getCanvas();
    var mapRect = mapCanvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;

    var outW = Math.round(w * dpr);
    var outH = Math.round(h * dpr);

    var canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    var ctx = canvas.getContext('2d');

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, outW, outH);

    var sx = (x - mapRect.left) * dpr;
    var sy = (y - mapRect.top) * dpr;

    var clipSx = Math.max(0, sx);
    var clipSy = Math.max(0, sy);
    var clipEx = Math.min(mapCanvas.width, sx + outW);
    var clipEy = Math.min(mapCanvas.height, sy + outH);
    var clipW = clipEx - clipSx;
    var clipH = clipEy - clipSy;

    var dx = clipSx - sx;
    var dy = clipSy - sy;

    if (clipW > 0 && clipH > 0) {
        ctx.drawImage(mapCanvas, clipSx, clipSy, clipW, clipH, dx, dy, clipW, clipH);
    }

    return canvas.toDataURL('image/png').split(',')[1];
}

function _download_png(base64) {
    var timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    var link = document.createElement('a');
    link.download = 'VortexRadar_' + timestamp + '.png';
    link.href = 'data:image/png;base64,' + base64;
    document.body.appendChild(link);
    link.click();
    link.remove();
}

// ---------- save flows ----------

function _hide_chrome() {
    if (_actionBar) { _actionBar.remove(); _actionBar = null; }
    if (_selection) { _selection.style.display = 'none'; }
    if (_overlay) { _overlay.style.display = 'none'; }
    $('#screenshotModeToolbar').hide();
}

function _do_save(base64) {
    _add_watermark(base64, function (finalBase64) {
        _download_png(finalBase64);
        notificationBubble.notify('Screenshot downloaded', {
            icon: 'fa fa-camera', level: 'success'
        });
        _exit_screenshot_mode();
    });
}

function _save_area(x, y, w, h) {
    _hide_chrome();

    requestAnimationFrame(function () {
        setTimeout(function () {
            try {
                var base64 = _capture_from_map(x, y, w, h);
                _do_save(base64);
            } catch (err) {
                notificationBubble.notify('Failed to capture screenshot', {
                    icon: 'fa fa-camera', level: 'warning'
                });
                _exit_screenshot_mode();
            }
        }, 80);
    });
}

function _capture_full_screen() {
    _hide_chrome();

    requestAnimationFrame(function () {
        setTimeout(function () {
            try {
                var mapRect = map.getCanvas().getBoundingClientRect();
                var base64 = _capture_from_map(mapRect.left, mapRect.top, mapRect.width, mapRect.height);
                _do_save(base64);
            } catch (err) {
                notificationBubble.notify('Failed to capture screenshot', {
                    icon: 'fa fa-camera', level: 'warning'
                });
                _exit_screenshot_mode();
            }
        }, 80);
    });
}

// ---------- button click ----------

$(icon_elem).on('click', function () {
    if (!_active) {
        _enter_screenshot_mode();
    } else {
        _exit_screenshot_mode();
    }
});
