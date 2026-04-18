var DOWNLOAD_FALLBACK_URL = 'https://github.com/snapsera/vortexradar/releases/latest/download/Vortex-Radar-Setup.exe';
var RELEASES_URL = 'https://github.com/snapsera/vortexradar/releases/latest';

var _overlay = null;
var _prompt = null;
var _toast = null;
var _pauseLocks = 0;
var _resumeLoopPlaybackOnClose = false;
var _hiddenGlobalButtons = {};
var _toastTimer = null;

function _is_desktop_app() {
    try {
        return new URLSearchParams(window.location.search || '').get('desktopApp') === '1';
    } catch (_) {
        return false;
    }
}

function _is_radar_preview_embed_mode() {
    try {
        return document.documentElement.classList.contains('radarPreviewEmbed');
    } catch (_) {
        return false;
    }
}

function _ensure_storm_track_data() {
    if (!window.stormTrackData) window.stormTrackData = {};
    return window.stormTrackData;
}

function _hide_global_corner_buttons() {
    var ids = ['#fullscreenToggleBtn', '#devConsoleQuickBtn'];
    for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var $el = $(id);
        if (!$el.length) continue;
        _hiddenGlobalButtons[id] = $el.css('display');
        $el.css('display', 'none');
    }
}

function _restore_global_corner_buttons() {
    var ids = Object.keys(_hiddenGlobalButtons);
    for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var $el = $(id);
        if (!$el.length) continue;
        $el.css('display', _hiddenGlobalButtons[id] || '');
    }
    _hiddenGlobalButtons = {};
}

function _set_paused_state(isPaused) {
    var stormTrackData = _ensure_storm_track_data();
    stormTrackData.appPausedForPromo = !!isPaused;

    var loopController = stormTrackData.radarLoopController;
    if (isPaused) {
        var loopPlayback = stormTrackData.loopPlayback || {};
        _resumeLoopPlaybackOnClose = !!(loopPlayback.playing || loopPlayback.preloading);
        try { if (loopController && typeof loopController._cancel_preload === 'function') loopController._cancel_preload(); } catch (_) {}
        try { if (loopController && typeof loopController.pause === 'function') loopController.pause(); } catch (_) {}
        _hide_global_corner_buttons();
        return;
    }

    _restore_global_corner_buttons();
    if (_resumeLoopPlaybackOnClose) {
        try { if (loopController && typeof loopController.play === 'function') loopController.play(); } catch (_) {}
    }
    _resumeLoopPlaybackOnClose = false;
}

function _acquire_pause_lock() {
    _pauseLocks += 1;
    if (_pauseLocks === 1) _set_paused_state(true);
}

function _release_pause_lock() {
    if (_pauseLocks <= 0) return;
    _pauseLocks -= 1;
    if (_pauseLocks === 0) _set_paused_state(false);
}

function _open_download_page() {
    if (!_overlay) return;
    if (_overlay.hasClass('desktopAppOverlay-visible')) return;
    _overlay.addClass('desktopAppOverlay-visible');
    _hide_download_toast();
    _acquire_pause_lock();
}

function _close_download_page() {
    if (!_overlay) return;
    if (!_overlay.hasClass('desktopAppOverlay-visible')) return;
    _overlay.removeClass('desktopAppOverlay-visible');
    _hide_download_toast();
    _release_pause_lock();
}

function _show_prompt() {
    if (!_prompt) return;
    if (_prompt.hasClass('desktopAppPromptOverlay-visible')) return;
    _prompt.addClass('desktopAppPromptOverlay-visible');
    _acquire_pause_lock();
}

function _hide_prompt() {
    if (!_prompt) return;
    if (!_prompt.hasClass('desktopAppPromptOverlay-visible')) return;
    _prompt.removeClass('desktopAppPromptOverlay-visible');
    _release_pause_lock();
}

function _open_download_link() {
    var targetUrl = DOWNLOAD_FALLBACK_URL;

    var iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.src = targetUrl;
    document.body.appendChild(iframe);
    setTimeout(function() {
        iframe.remove();
    }, 45000);
    _show_download_toast('started');
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function() {
        _show_download_toast('fallback');
    }, 2600);
}

function _show_download_toast(mode) {
    if (!_toast || !_toast.length) return;
    var html = '';
    if (mode === 'started') {
        html = '<i class="fa-solid fa-circle-check"></i><span>Download started. If your browser blocks it, use the fallback link.</span>' +
            '<button type="button" class="desktopAppToastLinkBtn" id="desktopAppToastFallbackBtn">If download didn\'t start, click here</button>';
    } else {
        html = '<i class="fa-solid fa-circle-info"></i><span>If the installer did not start downloading, use this direct link.</span>' +
            '<button type="button" class="desktopAppToastLinkBtn" id="desktopAppToastFallbackBtn">If download didn\'t start, click here</button>';
    }
    _toast.html(html).addClass('desktopAppToast-visible');
}

function _hide_download_toast() {
    if (_toastTimer) {
        clearTimeout(_toastTimer);
        _toastTimer = null;
    }
    if (_toast && _toast.length) _toast.removeClass('desktopAppToast-visible').empty();
}

function _open_releases_link() {
    window.open(RELEASES_URL, '_blank', 'noopener');
}

function _build_overlay_html() {
    return '' +
        '<div class="desktopAppOverlay" id="desktopAppOverlay">' +
            '<div class="desktopAppBackdrop" aria-hidden="true"></div>' +
            '<div class="desktopAppPage">' +
                '<div class="desktopAppPageHeader">' +
                    '<div class="desktopAppPageBrand">' +
                        '<img class="desktopAppPageLogo" src="images/vortexicon_rotate.svg" alt="Vortex Radar">' +
                        '<div>' +
                            '<div class="desktopAppPageTitle">Vortex Radar Desktop App</div>' +
                            '<div class="desktopAppPageSub">Built for full-time weather monitoring on Windows</div>' +
                        '</div>' +
                    '</div>' +
                    '<button type="button" class="desktopAppCloseBtn" id="desktopAppCloseBtn"><i class="fa-solid fa-xmark"></i> Close</button>' +
                '</div>' +
                '<div class="desktopAppPageBody">' +
                    '<div class="desktopAppHeroPanel">' +
                        '<img class="desktopAppHeroBgMedia" src="images/readme-screenshot-5-live-mode.gif" alt="" aria-hidden="true">' +
                        '<div class="desktopAppHeroKicker">Desktop Experience</div>' +
                        '<h2 class="desktopAppHeroTitle">A cleaner, faster way to run Vortex Radar</h2>' +
                        '<p class="desktopAppHeroLead">The desktop app keeps your radar workflow stable during active weather. No tab clutter, no accidental refreshes, and automatic updates as soon as new releases are out.</p>' +
                        '<div class="desktopAppActions">' +
                            '<button type="button" class="desktopAppDownloadBtn" id="desktopAppDownloadBtn"><i class="fa-solid fa-download"></i> Download for Windows</button>' +
                            '<button type="button" class="desktopAppSecondaryBtn" id="desktopAppReleasesBtn"><i class="fa-brands fa-github"></i> Release Notes</button>' +
                        '</div>' +
                    '</div>' +
                    '<div class="desktopAppInfoPanel">' +
                        '<div class="desktopAppInfoCard">' +
                            '<div class="desktopAppInfoTitle">Why install it?</div>' +
                            '<ul class="desktopAppFeatureList">' +
                                '<li><i class="fa-solid fa-circle-check"></i><span>One install, then updates download automatically from GitHub releases.</span></li>' +
                                '<li><i class="fa-solid fa-circle-check"></i><span>Runs as a dedicated app window so you can monitor without browser interruptions.</span></li>' +
                                '<li><i class="fa-solid fa-circle-check"></i><span>Same core Vortex Radar tools you already use on web, optimized for daily use.</span></li>' +
                            '</ul>' +
                        '</div>' +
                        '<div class="desktopAppInfoCard desktopAppInfoCard-muted">' +
                            '<div class="desktopAppInfoTitle">Quick setup</div>' +
                            '<ol class="desktopAppSteps">' +
                                '<li>Click <strong>Download for Windows</strong>.</li>' +
                                '<li>Run <strong>Vortex Radar Setup.exe</strong>.</li>' +
                                '<li>Launch the app and sign in as usual.</li>' +
                            '</ol>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="desktopAppToast" id="desktopAppToast" aria-live="polite"></div>' +
            '</div>' +
        '</div>' +
        '<div class="desktopAppPromptOverlay" id="desktopAppPromptOverlay">' +
            '<div class="desktopAppPromptCard">' +
                '<h3 class="desktopAppPromptTitle">Want the desktop app?</h3>' +
                '<p class="desktopAppPromptBody">You can install Vortex Radar on Windows for a smoother full-time setup and automatic updates. Would you like to open the download page now?</p>' +
                '<div class="desktopAppPromptActions">' +
                    '<button type="button" class="desktopAppPromptBtn desktopAppPromptBtn--no" id="desktopAppPromptNoBtn">No thanks</button>' +
                    '<button type="button" class="desktopAppPromptBtn desktopAppPromptBtn--yes" id="desktopAppPromptYesBtn">Yes, show me</button>' +
                '</div>' +
            '</div>' +
        '</div>';
}

function _bind_events() {
    $('#armrDesktopAppBtn').on('click', function() {
        try { require('./vortexRadarMenu').hideARMwindow(); } catch (_) {}
        _open_download_page();
    });

    $('#desktopAppCloseBtn').on('click', _close_download_page);

    $('#desktopAppDownloadBtn').on('click', _open_download_link);
    $('#desktopAppReleasesBtn').on('click', _open_releases_link);
    $(document).on('click', '#desktopAppToastFallbackBtn', function() {
        _open_releases_link();
    });

    $('#desktopAppPromptYesBtn').on('click', function() {
        _hide_prompt();
        _open_download_page();
    });
    $('#desktopAppPromptNoBtn').on('click', _hide_prompt);
    $('#desktopAppPromptOverlay').on('click', function(e) {
        if ($(e.target).attr('id') === 'desktopAppPromptOverlay') _hide_prompt();
    });
}

function _show_web_prompt_after_loading() {
    if (_is_desktop_app() || _is_radar_preview_embed_mode()) return;
    window.addEventListener('appBodyVisible', function() {
        setTimeout(function() {
            if (_overlay && _overlay.hasClass('desktopAppOverlay-visible')) return;
            _show_prompt();
        }, 700);
    }, { once: true });
}

function init() {
    if (_is_desktop_app()) {
        var $desktopBtn = $('#armrDesktopAppBtn');
        if ($desktopBtn.length) {
            $desktopBtn.addClass('menu-row--desktop-installed');
            $desktopBtn.attr('aria-disabled', 'true');
            $desktopBtn.find('.desktopNewTag')
                .removeClass('desktopNewTag')
                .addClass('desktopInstalledTag')
                .text('Installed');
            $desktopBtn.find('.armrIcon.fa-download')
                .removeClass('fa-download')
                .addClass('fa-circle-check');
            $desktopBtn.find('.armrIconArrowRight').hide();
            $desktopBtn.off('click').on('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
            });
        }
        return;
    }
    $('body').append(_build_overlay_html());
    _overlay = $('#desktopAppOverlay');
    _prompt = $('#desktopAppPromptOverlay');
    _toast = $('#desktopAppToast');
    _bind_events();
    _show_web_prompt_after_loading();
}

module.exports = { init: init };
