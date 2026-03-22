var map = require('../../core/map/map');
const ut = require('../../core/utils');
const getValue = require('./get_value');

const divElem = '#colorPickerItemDiv';
const iconElem = '#colorPickerItemClass';

let lastPoint = null;

function positionInspector(clientX, clientY) {
    const css = { left: clientX, top: clientY };
    $('#colorPickerBorder').css(css);
    $('#colorPicker').css(css);
    $('#colorPickerText').css({ left: clientX, top: clientY + 28 });
}

function onMouseMove(e) {
    lastPoint = e.point;
    positionInspector(e.originalEvent.clientX, e.originalEvent.clientY);
    $('.colorPicker').show();
    $('#colorPickerBorder').css('display', 'flex');
    getValue(e.point);
}

function onMapMove() {
    if (lastPoint) getValue(lastPoint);
}

function onMouseLeave() {
    $('.colorPicker').hide();
}

$(iconElem).on('click', function() {
    if (!$(iconElem).hasClass('menu_item_selected')) {
        $(iconElem).addClass('menu_item_selected');
        $(iconElem).removeClass('menu_item_not_selected');

        map.on('mousemove', onMouseMove);
        map.on('move', onMapMove);
        map.getCanvas().addEventListener('mouseleave', onMouseLeave);
        map.getCanvas().style.cursor = 'none';
    } else if ($(iconElem).hasClass('menu_item_selected')) {
        $(iconElem).removeClass('menu_item_selected');
        $(iconElem).addClass('menu_item_not_selected');

        $('.colorPicker').hide();
        map.off('mousemove', onMouseMove);
        map.off('move', onMapMove);
        map.getCanvas().removeEventListener('mouseleave', onMouseLeave);
        map.getCanvas().style.cursor = '';
        lastPoint = null;
    }
})
