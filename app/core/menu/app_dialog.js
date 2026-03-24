function display_app_dialog(options) {
    var title = options.title;
    var body = options.body;
    var color = options.color;
    var textColor = options.textColor;
    var isShowcaseDialog = typeof body === 'string'
        && (body.indexOf('alertInfoPanel') !== -1 || body.indexOf('aboutShowcasePanel') !== -1);

    $('#appDialog').show();
    $('#appDialog').toggleClass('appDialog-alertShowcase', isShowcaseDialog);
    $('#appDialogContainer').toggleClass('appDialog-alertShowcase', isShowcaseDialog);
    $('#appDialogContainer').css('--app-alert-accent', color || 'var(--color-accent)');

    $('#appDialogHeaderText').html(title);
    $('#appDialogHeaderSub').html(options.subtitle || 'National Weather Service');
    $('#appDialogHeader').css('background-color', color);
    $('#appDialogHeader').css('color', textColor);
    $('#appDialogClose').css('color', textColor);

    $('#appDialogBody').scrollTop(0);
    $('#appDialogBody').html(body);
}

$('#appDialog').on('click', function(e) {
    if ($(e.target).closest('#appDialogClose').length || $(e.target).attr('id') === 'appDialog') {
        $(this).removeClass('appDialog-alertShowcase');
        $('#appDialogContainer').removeClass('appDialog-alertShowcase');
        $(this).hide();
    }
})

module.exports = display_app_dialog;