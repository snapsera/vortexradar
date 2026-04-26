const ut = require('../utils');
const loaders_nexrad = require('../../radar/libnexrad/loaders_nexrad');
const settings_store = require('./settings_store');

var productLookup = {
    1: {
        'ref': 'N0B',
        'vel': 'N0G',
        'srvel': 'N0G',
        'lowres-ref': 'p94r0',
        'lowres-vel': 'p99v0',
        'rho': 'N0C',
        'zdr': 'N0X',
        'sw ': 'p30sw',
        'hhc': 'HHC',
        'hyc': 'N0H',
        'srv': 'N0S',
        'vil': '134il',
        'kdp': 'N0K',
        'sr-ref': 'TZ0',
        'lr-ref': 'TZL',
        'tdwrVel': 'TV0',
    },
    2: {
        'ref': 'N1B',
        'vel': 'NAG',
        'srvel': 'NAG',
        'lowres-ref': 'p94r1',
        'lowres-vel': 'p99v1',
        'rho': 'N1C',
        'zdr': 'N1X',
        'hhc': 'HHC',
        'hyc': 'N1H',
        'srv': 'N1S',
        'kdp': 'N1K',
        'sr-ref': 'TZ1',
        'tdwrVel': 'TV1',
    },
    3: {
        'ref': 'N2B',
        'vel': 'N1G',
        'srvel': 'N1G',
        'lowres-ref': 'p94r2',
        'lowres-vel': 'p99v2',
        'rho': 'N2C',
        'zdr': 'N2X',
        'hyc': 'N2H',
        'srv': 'N2S',
        'kdp': 'N2K',
        'sr-ref': 'TZ2',
        'tdwrVel': 'TV2',
    },
    4: {
        'ref': 'N3B',
        'lowres-ref': 'p94r3',
        'lowres-vel': 'p99v3',
        'rho': 'N3C',
        'zdr': 'N3X',
        'hyc': 'N3H',
        'srv': 'N3S',
        'kdp': 'N3K',
    }
}


var psmOpen = false;
var psmClosingTimer = null;

function showPSM() {
    var psm = $('#productSelectionMenu');
    var trigger = $('#productsDropdownTrigger');
    var footer = $('#productMapFooter');
    var triggerRect = trigger[0].getBoundingClientRect();
    var footerRect = footer[0].getBoundingClientRect();

    if (psmClosingTimer) {
        clearTimeout(psmClosingTimer);
        psmClosingTimer = null;
    }

    psm.css({
        display: 'block',
        bottom: (window.innerHeight - footerRect.top + 6) + 'px',
        left: triggerRect.left + 'px'
    });

    psm[0].offsetWidth;
    psm.addClass('psm-open');
    psmOpen = true;

    setTimeout(function() {
        $(document.body).on('click.psm', function(e) {
            var isOnRestrictedElem =
                psm.find($(e.target)).length == 1 ||
                $(e.target).is(psm) ||
                $(e.target).hasClass('psmNoHideElem');

            if (!isOnRestrictedElem && !$(e.target).hasClass('pdt')) {
                hidePSM();
            }
        });
    }, 0);
}

function hidePSM() {
    var psm = $('#productSelectionMenu');
    psm.removeClass('psm-open');
    psmOpen = false;
    $(document.body).off('click.psm');

    psmClosingTimer = setTimeout(function() {
        psm.css('display', 'none');
        psmClosingTimer = null;
    }, 350);
}

$('#productsDropdownTrigger').click(function(e) {
    if (psmOpen) {
        hidePSM();
    } else {
        showPSM();
    }
})


function loadTiltBtns(numOfTiltsArr) {
    // copy the array so it doesn't modify the original
    var arr = [...numOfTiltsArr];
    arr = arr.reverse();

    var containerElem = $('#psmTiltDropdown');
    containerElem.empty();
    for (var i in arr) {
        containerElem.prepend($(`<div class="psmTiltDropdownRow psmNoHideElem" value="${arr[i]}">Tilt ${arr[i]}</div>`));
    }
}

$('.psmRow').click(function(e) {
    if ($(e.target).is($(this)) && !$(this).hasClass('l2prodSel')) {
        const usRadarEnabled = !!window?.stormTrackData?.usRadarEnabled || !!settings_store.load().usRadar;
        if (usRadarEnabled) return;

        const currentStation = window.stormTrackData.currentStation; // 'KAKQ';
        if (!currentStation) return;

        var innerText = $(this).text(); // the long product name, e.g. "Base Reflectivity"
        var value = $(this).attr('value'); // the abbreviated product name, e.g. "ref", "vel", "hyc"

        $('#productsDropdownTriggerText').text(longProductNames[value]);

        var selectedTiltNum = $(this).find('.psmRowTiltSelect').text().split(' ')[1];
        var resultProduct = productLookup[selectedTiltNum][value];
        // Close the product submenu as soon as a product is chosen.
        hidePSM();
        window.dispatchEvent(new CustomEvent('radarBaseSelectionRequested', {
            detail: {
                station: currentStation,
                product: resultProduct
            }
        }));

        window.stormTrackData.from_file_upload = false;
        if (value == 'srvel') {
            loaders_nexrad.quick_storm_relative_velocity_plot(currentStation, resultProduct, (L3Factory) => { });
        } else {
            loaders_nexrad.quick_level_3_plot(currentStation, resultProduct, (L3Factory) => { });
        }
        // loaders.getLatestFile(currentStation, [3, resultProduct, 0], function(url) {
        //     console.log(url)
        //     loaders.loadFileObject(ut.phpProxy + url + '#', 3);
        // })
    }
})

$('.psmRow').on('mouseover mousemove', function(e) {
    // we don't want to highlight the row if we're hovering over the tilt menu
    if ($(e.target).is($(this))) {
        $(this).css('background-color', 'rgb(85, 85, 85)');
    } else {
        $(this).css('background-color', '');
    }
}).on('mouseleave', function(e) {
    $(this).css('background-color', '');
})


function disableScrolling() {
    $('#productSelectionMenu').css('overflow', 'hidden');
    $('#psmTiltDropdownBackdrop').show();
}
function enableScrolling() {
    $('#productSelectionMenu').css('overflow', 'scroll');
    $('#psmTiltDropdownBackdrop').hide();
}

$('#psmTiltDropdownBackdrop').click(function(e) {
    enableScrolling();
    $('#psmTiltDropdown').hide();
})

$('.psmRowTiltSelect').click(function() {
    const fadeDuration = 100;
    // the blue text element with "Tilt X" written
    var thisObj = $(this);
    // the abbreviated product associated with the current row
    var thisProduct = thisObj.parent().attr('value');
    // fix the dropdown menu to display the correct number of tilts
    var numOfTilts = ut.numOfTiltsObj[thisProduct];
    loadTiltBtns(numOfTilts);
    // prevent the user from scrolling the productSelectionMenu
    disableScrolling();

    // the dropdown menu where you can select the tilts
    var psmTiltDropdown = $('#psmTiltDropdown');
    // show the dropdown and position it above the blue text element
    psmTiltDropdown.show().position({
        my: `center top`,
        at: `center top-${psmTiltDropdown.height() + 17}`,
        of: thisObj
    }); // .hide().fadeIn(fadeDuration);

    // when the user clicks on one of the tilt options in the dropdown menu
    $('.psmTiltDropdownRow').click(function() {
        // reset all blue text elements to display "Tilt 1"
        $('.psmRowTiltSelect').each(function() {
            $(this).text('Tilt 1');
        })
        // set the blue text element to read the text of the selected dropdown item
        thisObj.text($(this).text());
        // re-enable scrolling on the productSelectionMenu
        enableScrolling();
        // hide the dropdown menu
        psmTiltDropdown.hide();
        // remove the current event listener
        $('.psmTiltDropdownRow').off('click');

        // trigger a click on the row, which automatically re-loads the product with the new tilt
        $(`.psmRow[value="${thisProduct}"]`).click();
    })
})