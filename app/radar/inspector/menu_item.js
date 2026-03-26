var map = require('../../core/map/map');
const ut = require('../../core/utils');
const getValue = require('./get_value');

const divElem = '#colorPickerItemDiv';
const iconElem = '#colorPickerItemClass';

function positionInspector(clientX, clientY) {
    const css = { left: clientX, top: clientY };
    $('#colorPickerBorder').css(css);
    $('#colorPicker').css(css);
    $('#colorPickerText').css({ left: clientX, top: clientY + 28 });
}

function getViewportCenterClientCoords() {
    return {
        clientX: window.innerWidth / 2,
        clientY: window.innerHeight / 2
    };
}

function updateCenteredInspector() {
    const { clientX, clientY } = getViewportCenterClientCoords();
    positionInspector(clientX, clientY);
    $('.colorPicker').show();
    $('#colorPickerBorder').css('display', 'flex');
    getValue();
}

function onMapMove() {
    updateCenteredInspector();
}

function onWindowResize() {
    updateCenteredInspector();
}

$(iconElem).on('click', function() {
    if (!$(iconElem).hasClass('menu_item_selected')) {
        $(iconElem).addClass('menu_item_selected');
        $(iconElem).removeClass('menu_item_not_selected');

        map.on('move', onMapMove);
        map.on('resize', onMapMove);
        window.addEventListener('resize', onWindowResize);
        updateCenteredInspector();
    } else if ($(iconElem).hasClass('menu_item_selected')) {
        $(iconElem).removeClass('menu_item_selected');
        $(iconElem).addClass('menu_item_not_selected');

        $('.colorPicker').hide();
        map.off('move', onMapMove);
        map.off('resize', onMapMove);
        window.removeEventListener('resize', onWindowResize);
        map.getCanvas().style.cursor = '';
    }
})
