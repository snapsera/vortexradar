function showARMwindow() {
    $('.armScreen').stop(true, true).hide().css({ left: 0, opacity: 1 });
    $('#appMenuMainScreen').show();
    currentScreen = '#appMenuMainScreen';
    $('#leftPanel').removeClass('leftPanel-closed').addClass('leftPanel-open');
}
function hideARMwindow() {
    $('#leftPanel').removeClass('leftPanel-open').addClass('leftPanel-closed');
    $('.armScreen').stop(true, true).hide().css({ left: 0, opacity: 1 });
    $('#appMenuMainScreen').show();
    currentScreen = '#appMenuMainScreen';
}

$(function() {
    var body = $('#appMenuBody');
    if (body.length && $('#leftPanelContent').length) {
        body.appendTo('#leftPanelContent');
        $('#appMenu').hide();
    }

    $('.menu-category-header').on('click', function() {
        var $category = $(this).closest('.menu-category');
        var $body = $category.find('.menu-category-body');
        $category.toggleClass('open');
        $body.slideToggle(150);
    });
});

// provided by ChatGPT
$.fn.rotateArrow = function (degrees, easing, duration) {
    return this.each(function () {
        var el = $(this);
        var currentRotation = getRotationDegrees(el);
        var finalRotation = currentRotation + degrees;
        el.animate({
            deg: finalRotation
        }, {
            duration: duration,
            easing: easing,
            step: function (now) {
                el.css({
                    transform: "rotate(" + now + "deg)"
                });
            }
        });
    });
};
function getRotationDegrees(el) {
    var st = window.getComputedStyle(el[0], null);
    var tr = st.getPropertyValue("-webkit-transform") ||
        st.getPropertyValue("-moz-transform") ||
        st.getPropertyValue("-ms-transform") ||
        st.getPropertyValue("-o-transform") ||
        st.getPropertyValue("transform");
    if (tr == 'none') return 0;
    var values = tr.split('(')[1].split(')')[0].split(',');
    var a = values[0];
    var b = values[1];
    var angle = Math.round(Math.atan2(b, a) * (180 / Math.PI));
    return (angle < 0 ? angle + 360 : angle);
}

$('#appMenu').on('click', function(e) {
    var clickedTarget = $(e.target).attr('id');
    if (clickedTarget == 'appMenu'/* || clickedTarget == 'appDialogClose'*/) {
        hideARMwindow();
    }
});
$('.armsHeaderExitBtn').click(function() {
    hideARMwindow();
});

function slideDownToggle(armrElem, armrSlideDownElem) {
    const duration = 150;
    const easing = 'swing';
    var arrow = armrElem.find('.armrIconArrowRight');
    var toggleswitch = armrSlideDownElem.find('.toggleSwitchContainter');

    if (arrow.data('rotationStatus') == 'normal' || arrow.data('rotationStatus') == undefined) {
        armrElem.addClass('armrTop');
        if (toggleswitch.length) { toggleswitch.hide().fadeIn(duration / 1.5); }
        armrSlideDownElem.slideDown(duration);
        arrow.rotateArrow(90, easing, duration);
        arrow.data('rotationStatus', 'down');
    } else {
        if (toggleswitch.length) { toggleswitch.fadeOut(duration / 1.5); }
        armrSlideDownElem.slideUp(duration, function() {
            armrElem.removeClass('armrTop');
        });
        arrow.rotateArrow(-90, easing, duration);
        arrow.data('rotationStatus', 'normal');
    }
}

function toggleswitchFunctions(switchElem, onFunction, offFunction, onclick_function = function() {}) {
    switchElem.on('click', function() {
        var checkbox = $(this);
        var isChecked = checkbox.is(':checked');
        if (isChecked) { onFunction.apply(this, []); }
        else { offFunction.apply(this, []); }
        onclick_function.apply(this, []);
    });
}

$('.armrSlideDown').hover(function() {
    $(this).css('background-color', 'rgb(60, 60, 60)');
    $(this).css('cursor', 'default');
});

const slideDuration = 200;

var mainMenuScreen = '#appMenuMainScreen';
var settingsScreen = '#appMenuSettingsScreen';
var spcScreen = '#appMenuSPCScreen';
var devToolsScreen = '#appMenuDevToolsScreen';
var allScreens = [mainMenuScreen, settingsScreen, spcScreen, devToolsScreen];
var currentScreen = mainMenuScreen;

function slideToScreen(targetScreen, direction) {
    if (targetScreen === currentScreen) return;

    var $container = $('#appMenuBody');
    var containerWidth = $container.outerWidth() || 350;
    var slideOut = direction === 'forward' ? -containerWidth : containerWidth;
    var slideIn = direction === 'forward' ? containerWidth : -containerWidth;

    var $current = $(currentScreen);
    var $target = $(targetScreen);

    $current.stop(true, false);
    $target.stop(true, false);

    $current.animate({ left: slideOut, opacity: 0 }, slideDuration, function() {
        $(this).hide().css({ left: 0, opacity: 1 });
    });

    $target.scrollTop(0).css({ left: slideIn, opacity: 0, display: 'block' })
        .animate({ left: 0, opacity: 1 }, slideDuration);

    currentScreen = targetScreen;
}

$('#armrSettingsBtn').click(function() {
    slideToScreen(settingsScreen, 'forward');
});
$('#armsSettingsBackBtn').click(function() {
    slideToScreen(mainMenuScreen, 'back');
});

$('#armrSPCOutlooksBtn').click(function() {
    slideToScreen(spcScreen, 'forward');
});
$('#armsSPCBackBtn').click(function() {
    slideToScreen(mainMenuScreen, 'back');
});

$('#armrDevToolsBtn').click(function() {
    slideToScreen(devToolsScreen, 'forward');
});
$('#armsDevToolsBackBtn').click(function() {
    slideToScreen(mainMenuScreen, 'back');
});

$('#armrColortablesBtn').click(function() {
    $('#colortablesModal').fadeIn(150);
});
$('#colortablesModalClose').click(function() {
    $('#colortablesModal').fadeOut(150);
});
$('#colortablesModal').on('click', function(e) {
    if (e.target === this) $(this).fadeOut(150);
});

module.exports = {
    slideDownToggle,
    toggleswitchFunctions,
    showARMwindow,
    hideARMwindow
};
