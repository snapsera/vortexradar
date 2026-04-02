function _teardown_drag() {
    $(document).off('.appDialogDrag');
    $('#appDialogHeader').off('.appDialogDrag');
}

function _setup_draggable_dialog() {
    var $dialog = $('#appDialog');
    var $container = $('#appDialogContainer');
    var $header = $('#appDialogHeader');
    var container = $container.get(0);
    if (!container) return;

    _teardown_drag();

    $dialog.addClass('appDialog-draggableMode');
    $container.addClass('appDialog-draggable');

    const width = container.offsetWidth || 620;
    const height = container.offsetHeight || 520;
    const startLeft = Math.max(12, Math.round((window.innerWidth - width) / 2));
    const startTop = Math.max(12, Math.round((window.innerHeight - height) / 2));
    $container.css({ left: startLeft + 'px', top: startTop + 'px' });

    let dragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    $header.on('mousedown.appDialogDrag', function(e) {
        if ($(e.target).closest('#appDialogClose').length) return;
        dragging = true;
        dragOffsetX = e.clientX - container.getBoundingClientRect().left;
        dragOffsetY = e.clientY - container.getBoundingClientRect().top;
        e.preventDefault();
    });

    $(document).on('mousemove.appDialogDrag', function(e) {
        if (!dragging) return;
        const maxLeft = Math.max(12, window.innerWidth - container.offsetWidth - 12);
        const maxTop = Math.max(12, window.innerHeight - container.offsetHeight - 12);
        const left = Math.min(maxLeft, Math.max(12, e.clientX - dragOffsetX));
        const top = Math.min(maxTop, Math.max(12, e.clientY - dragOffsetY));
        $container.css({ left: left + 'px', top: top + 'px' });
    });

    $(document).on('mouseup.appDialogDrag', function() {
        dragging = false;
    });
}

function _clear_dialog_state() {
    $('#appDialog').removeClass('appDialog-alertShowcase appDialog-stormReport appDialog-noBlur appDialog-draggableMode appDialog-clickThrough');
    $('#appDialogContainer')
        .removeClass('appDialog-alertShowcase appDialog-stormReport appDialog-draggable')
        .css({ left: '', top: '' });
    _teardown_drag();
}

function display_app_dialog(options) {
    var title = options.title;
    var body = options.body;
    var color = options.color;
    var textColor = options.textColor;
    var isShowcaseDialog = typeof body === 'string'
        && (body.indexOf('alertInfoPanel') !== -1 || body.indexOf('aboutShowcasePanel') !== -1);
    var isStormReportDialog = options.dialogClass === 'appDialog-stormReport';

    _clear_dialog_state();
    $('#appDialog').show();
    $('#appDialog').toggleClass('appDialog-alertShowcase', isShowcaseDialog);
    $('#appDialogContainer').toggleClass('appDialog-alertShowcase', isShowcaseDialog);
    $('#appDialog').toggleClass('appDialog-stormReport', isStormReportDialog);
    $('#appDialogContainer').toggleClass('appDialog-stormReport', isStormReportDialog);
    $('#appDialog').toggleClass('appDialog-noBlur', !!options.noBackdropBlur);
    $('#appDialog').toggleClass('appDialog-clickThrough', !!options.allowBackgroundInteraction);
    $('#appDialogContainer').css('--app-alert-accent', color || 'var(--color-accent)');

    $('#appDialogHeaderText').html(title);
    $('#appDialogHeaderSub').html(options.subtitle || 'National Weather Service');
    $('#appDialogHeader').css('background-color', color);
    $('#appDialogHeader').css('color', textColor);
    $('#appDialogClose').css('color', textColor);

    $('#appDialogBody').scrollTop(0);
    $('#appDialogBody').html(body);

    if (options.draggable) {
        _setup_draggable_dialog();
    }
}

$('#appDialog').on('click', function(e) {
    if ($(e.target).closest('#appDialogClose').length) {
        _clear_dialog_state();
        $(this).hide();
        return;
    }
    if ($(e.target).attr('id') === 'appDialog' && !$(this).hasClass('appDialog-clickThrough')) {
        _clear_dialog_state();
        $(this).hide();
    }
})

module.exports = display_app_dialog;