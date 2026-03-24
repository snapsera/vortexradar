function _resetAllScreens() {
    $('.armScreen').removeClass('armScreen--active armScreen--sliding').css({ transform: '' });
}

function showARMwindow() {
    _resetAllScreens();
    $('#appMenuMainScreen').addClass('armScreen--active');
    currentScreen = '#appMenuMainScreen';
    _sliding = false;
    $('#leftPanel').removeClass('leftPanel-closed').addClass('leftPanel-open');
}
function hideARMwindow() {
    $('#leftPanel').removeClass('leftPanel-open').addClass('leftPanel-closed');
    _resetAllScreens();
    $('#appMenuMainScreen').addClass('armScreen--active');
    currentScreen = '#appMenuMainScreen';
    _sliding = false;
}

$(function() {
    var body = $('#appMenuBody');
    if (body.length && $('#leftPanelContent').length) {
        body.appendTo('#leftPanelContent');
        $('#appMenu').hide();
    }

    _resetAllScreens();
    $('#appMenuMainScreen').addClass('armScreen--active');

    var host = window.location.hostname;
    if (host !== 'localhost' && host !== '127.0.0.1') {
        $('#menuCategoryDeveloper').remove();
        $('#appMenuDevToolsScreen').remove();
        $('#devConsolePanel').remove();
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

var SLIDE_MS = 280;

var mainMenuScreen = '#appMenuMainScreen';
var settingsScreen = '#appMenuSettingsScreen';
var spcScreen = '#appMenuSPCScreen';
var devToolsScreen = '#appMenuDevToolsScreen';
var ttsAlertsScreen = '#appMenuTTSAlertsScreen';
var audibleAlertsScreen = '#appMenuAudibleAlertsScreen';
var themeScreen = '#appMenuThemeScreen';
var allScreens = [mainMenuScreen, settingsScreen, spcScreen, devToolsScreen, ttsAlertsScreen, audibleAlertsScreen, themeScreen];
var currentScreen = mainMenuScreen;
var _sliding = false;

function slideToScreen(targetScreen, direction) {
    if (targetScreen === currentScreen) return;
    if (_sliding) return;
    _sliding = true;

    var $current = $(currentScreen);
    var $target = $(targetScreen);
    var $body = $('#appMenuBody');
    var $scroll = $('#leftPanelContent');

    $scroll.css('overflow', 'hidden');

    var startHeight = $current[0].scrollHeight;
    $body.css({ height: startHeight + 'px' });

    $current.removeClass('armScreen--active').addClass('armScreen--sliding');
    $target.addClass('armScreen--sliding armScreen--slide-in');

    var inX = direction === 'forward' ? '100%' : '-100%';
    var outX = direction === 'forward' ? '-100%' : '100%';

    $current.css('transform', 'translateX(0)');
    $target.scrollTop(0).css('transform', 'translateX(' + inX + ')');

    $body[0].offsetWidth;

    var targetHeight = $target[0].scrollHeight;
    $body.css({ transition: 'height ' + SLIDE_MS + 'ms cubic-bezier(0.4,0,0.2,1)', height: targetHeight + 'px' });
    $current.css('transform', 'translateX(' + outX + ')');
    $target.css('transform', 'translateX(0)');

    var prev = currentScreen;
    currentScreen = targetScreen;

    setTimeout(function() {
        $(prev).removeClass('armScreen--sliding armScreen--slide-in').css('transform', '');
        $target.removeClass('armScreen--sliding armScreen--slide-in').addClass('armScreen--active').css('transform', '');
        $body.css({ height: '', transition: '' });
        $scroll.css('overflow', '');
        _sliding = false;
    }, SLIDE_MS + 20);
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

$('#armrTTSAlertsBtn').click(function() {
    slideToScreen(ttsAlertsScreen, 'forward');
});
$('#armsTTSAlertsBackBtn').click(function() {
    slideToScreen(mainMenuScreen, 'back');
});

$('#armrAudibleAlertsBtn').click(function() {
    slideToScreen(audibleAlertsScreen, 'forward');
});
$('#armsAudibleAlertsBackBtn').click(function() {
    slideToScreen(mainMenuScreen, 'back');
});

$('#armrThemeBtn').click(function() {
    slideToScreen(themeScreen, 'forward');
});
$('#armsThemeBackBtn').click(function() {
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
