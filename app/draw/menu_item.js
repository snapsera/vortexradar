const draw_functions = require('./draw_functions');

const div_elem = '#drawMenuItemDiv';
const icon_elem = '#drawMenuItemIcon';

const BRUSH_SIZES = [
    { label: '1px', value: 1 },
    { label: '2px', value: 2 },
    { label: '4px', value: 4 },
    { label: '8px', value: 8 },
    { label: '12px', value: 12 },
    { label: '20px', value: 20 },
    { label: '32px', value: 32 }
];

const UI_ELEMENTS_TO_HIDE = [
    '#floatingToolbar',
    '#productMapFooter',
    '#leftPanel',
    '#alertsPanel',
    '#focusNewAlertsPanel',
    '#attributionDiv',
    '#colorScalePicker',
    '#colorPicker',
    '#colorPickerBorder',
    '#colorPickerText',
    '#productSelectionMenu',
    '#hurricaneLegendDiv',
    '#appMenu',
    '#appDialog'
];

function _dot_html(px) {
    var d = Math.max(4, Math.min(px, 24));
    return '<span class="drawSizeDotInner" style="width:' + d + 'px;height:' + d + 'px"></span>';
}

function _build_size_popout(currentSize) {
    var rows = '';
    for (var i = 0; i < BRUSH_SIZES.length; i++) {
        var s = BRUSH_SIZES[i];
        var active = s.value === currentSize ? ' drawSizeDot-active' : '';
        rows += '<button type="button" class="drawSizeDot' + active + '" data-size="' + s.value + '" title="' + s.value + 'px">' +
            _dot_html(s.value) +
        '</button>';
    }
    return '<div id="drawSizePopout" class="drawSizePopout">' + rows + '</div>';
}

function _build_draw_toolbar() {
    var settings = draw_functions.get_settings();

    return '<div id="drawToolbar" class="drawToolbar">' +
        '<div class="drawToolbarInner">' +
            '<div class="drawToolSection">' +
                '<label class="drawToolLabel">Color</label>' +
                '<input type="color" id="drawColorPicker" class="drawColorInput" value="' + settings.color + '">' +
            '</div>' +
            '<button type="button" id="drawSizeBtn" class="drawToolBtn" title="Brush Size">' +
                _dot_html(settings.brushSize) +
            '</button>' +
            '<div class="drawToolDivider"></div>' +
            '<button type="button" id="drawPenBtn" class="drawToolBtn' + (settings.tool === 'pen' ? ' drawToolBtn-active' : '') + '" title="Pen">' +
                '<i class="fa-solid fa-pen"></i>' +
            '</button>' +
            '<button type="button" id="drawEraserBtn" class="drawToolBtn' + (settings.tool === 'eraser' ? ' drawToolBtn-active' : '') + '" title="Eraser">' +
                '<i class="fa-solid fa-eraser"></i>' +
            '</button>' +
            '<div class="drawToolDivider"></div>' +
            '<button type="button" id="drawClearBtn" class="drawToolBtn drawToolBtn-danger" title="Clear All">' +
                '<i class="fa-solid fa-trash-can"></i>' +
            '</button>' +
            '<div class="drawToolDivider"></div>' +
            '<button type="button" id="drawCloseBtn" class="drawToolBtn drawToolBtn-close" title="Exit Draw Mode">' +
                '<i class="fa-solid fa-xmark"></i>' +
            '</button>' +
        '</div>' +
    '</div>';
}

function _close_size_popout() {
    $('#drawSizePopout').remove();
}

function _toggle_size_popout() {
    if ($('#drawSizePopout').length) {
        _close_size_popout();
        return;
    }
    var settings = draw_functions.get_settings();
    var $btn = $('#drawSizeBtn');
    $btn.after(_build_size_popout(settings.brushSize));

    requestAnimationFrame(function () {
        $('#drawSizePopout').addClass('drawSizePopout-visible');
    });

    $('#drawSizePopout').on('click', '.drawSizeDot', function (e) {
        e.stopPropagation();
        var size = parseInt($(this).data('size'), 10);
        draw_functions.set_brush_size(size);
        $('#drawSizeBtn').html(_dot_html(size));
        _close_size_popout();
    });
}

function _bind_toolbar() {
    $('#drawColorPicker').on('input change', function () {
        draw_functions.set_color($(this).val());
        if (!$('#drawPenBtn').hasClass('drawToolBtn-active')) {
            $('#drawPenBtn').click();
        }
    });

    $('#drawSizeBtn').on('click', function (e) {
        e.stopPropagation();
        _toggle_size_popout();
    });

    $('#drawPenBtn').on('click', function () {
        draw_functions.set_tool('pen');
        $('.drawToolBtn').removeClass('drawToolBtn-active');
        $(this).addClass('drawToolBtn-active');
    });

    $('#drawEraserBtn').on('click', function () {
        draw_functions.set_tool('eraser');
        $('.drawToolBtn').removeClass('drawToolBtn-active');
        $(this).addClass('drawToolBtn-active');
    });

    $('#drawClearBtn').on('click', function () {
        draw_functions.clear_canvas();
    });

    $('#drawCloseBtn').on('click', function () {
        _exit_draw_mode();
    });

    $(document).on('mousedown.drawSizePopout', function (e) {
        if (!$(e.target).closest('#drawSizePopout, #drawSizeBtn').length) {
            _close_size_popout();
        }
    });
}

function _unbind_toolbar() {
    $(document).off('mousedown.drawSizePopout');
}

function _hide_ui() {
    for (var i = 0; i < UI_ELEMENTS_TO_HIDE.length; i++) {
        $(UI_ELEMENTS_TO_HIDE[i]).addClass('drawMode-hidden');
    }
}

function _show_ui() {
    for (var i = 0; i < UI_ELEMENTS_TO_HIDE.length; i++) {
        $(UI_ELEMENTS_TO_HIDE[i]).removeClass('drawMode-hidden');
    }
}

var _panelsBeforeDraw = { alerts: false, left: false };

function _close_open_panels() {
    _panelsBeforeDraw.alerts = $('#alertsPanel').hasClass('alertsPanel-open');
    _panelsBeforeDraw.left = $('#leftPanel').hasClass('leftPanel-open');

    if (_panelsBeforeDraw.alerts) {
        $('#alertsPanel').removeClass('alertsPanel-open').addClass('alertsPanel-closed');
        $('#alertMenuItemIcon').removeClass('menu_item_selected').addClass('menu_item_not_selected');
        $('#floatingToolbar').css('right', '12px');
    }
    if (_panelsBeforeDraw.left) {
        $('#leftPanel').removeClass('leftPanel-open').addClass('leftPanel-closed');
    }
}

function _restore_panels() {
    if (_panelsBeforeDraw.alerts) {
        $('#alertsPanel').removeClass('alertsPanel-closed').addClass('alertsPanel-open');
        $('#alertMenuItemIcon').addClass('menu_item_selected').removeClass('menu_item_not_selected');
        $('#floatingToolbar').css('right', '372px');
    }
    if (_panelsBeforeDraw.left) {
        $('#leftPanel').removeClass('leftPanel-closed').addClass('leftPanel-open');
    }
}

function _enter_draw_mode() {
    _close_open_panels();

    $(icon_elem).addClass('menu_item_selected');
    $(icon_elem).removeClass('menu_item_not_selected');

    if ($('#colorPickerItemClass').hasClass('menu_item_selected')) {
        $('#colorPickerItemClass').click();
    }

    draw_functions.enable_drawing();
    _hide_ui();

    $('body').append(_build_draw_toolbar());

    var $tb = $('#drawToolbar');
    requestAnimationFrame(function () {
        $tb.addClass('drawToolbar-visible');
    });

    _bind_toolbar();
}

function _exit_draw_mode() {
    $(icon_elem).removeClass('menu_item_selected');
    $(icon_elem).addClass('menu_item_not_selected');

    _unbind_toolbar();
    _close_size_popout();

    var $tb = $('#drawToolbar');
    $tb.removeClass('drawToolbar-visible');
    $tb.addClass('drawToolbar-closing');
    setTimeout(function () { $tb.remove(); }, 250);

    draw_functions.disable_drawing();
    _show_ui();
    _restore_panels();
}

$(icon_elem).on('click', function () {
    if (!$(icon_elem).hasClass('menu_item_selected')) {
        _enter_draw_mode();
    } else {
        _exit_draw_mode();
    }
});

$('#colorPickerItemDiv').on('click', function () {
    if ($(this).find('span').hasClass('menu_item_selected')) {
        if ($(icon_elem).hasClass('menu_item_selected')) {
            _exit_draw_mode();
        }
    }
});
