const fetch_data = require('./fetch_data');
const alerts_panel = require('./alerts_panel');

const div_elem = '#alertMenuItemDiv';
const icon_elem = '#alertMenuItemIcon';

$(icon_elem).on('click', function () {
    if (!$(icon_elem).hasClass('menu_item_selected')) {
        $(icon_elem).addClass('menu_item_selected');
        $(icon_elem).removeClass('menu_item_not_selected');
        alerts_panel.refresh_alerts_list();
        alerts_panel.open_panel();
    } else {
        $(icon_elem).removeClass('menu_item_selected');
        $(icon_elem).addClass('menu_item_not_selected');
        alerts_panel.close_panel();
    }
})