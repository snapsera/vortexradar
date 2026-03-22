const iconElem = '#metarStationMenuItemIcon';

// Temperature/METAR button disabled
$(iconElem).off('click').on('click', function(e) {
    e.preventDefault();
    return false;
});
$(iconElem).css({ opacity: 0.4, cursor: 'not-allowed', pointerEvents: 'none' });
$('#metarStationMenuItemDiv').css({ opacity: 0.4, cursor: 'not-allowed', pointerEvents: 'none' });