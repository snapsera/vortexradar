function setShutdownOverlayState(state, details) {
    const overlay = document.getElementById('stormTrackShutdownOverlay');
    const status  = document.getElementById('stormTrackShutdownStatus');
    const detailsElem = document.getElementById('stormTrackShutdownDetails');
    const quitBtn = document.getElementById('stormTrackShutdownQuitBtn');
    const spinner = document.getElementById('stormTrackShutdownSpinner');
    const checkIcon = document.getElementById('stormTrackShutdownCheck');
    const warnIcon  = document.getElementById('stormTrackShutdownWarn');

    if (!overlay || !status || !detailsElem) return;

    const visible = state === 'stopping' || state === 'stopped' || state === 'error';
    overlay.style.display = visible ? 'flex' : 'none';
    if (!visible) return;

    const showEl = (el) => { if (el) { el.classList.remove('stormTrackShutdownIcon--hidden'); } };
    const hideEl = (el) => { if (el) { el.classList.add('stormTrackShutdownIcon--hidden'); } };

    if (state === 'stopping') {
        showEl(spinner);
        hideEl(checkIcon);
        hideEl(warnIcon);
        status.textContent = 'Shutting down\u2026';
        detailsElem.textContent = details || 'Please wait while StormTrack Pro shuts down safely.';
        if (quitBtn) { quitBtn.disabled = true; quitBtn.classList.add('stormTrackShutdownQuitBtn--hidden'); }
        return;
    }

    if (state === 'stopped') {
        hideEl(spinner);
        showEl(checkIcon);
        hideEl(warnIcon);
        if (checkIcon) { checkIcon.classList.add('stormTrackShutdownIcon--check'); checkIcon.classList.remove('stormTrackShutdownIcon--warn'); }
        status.textContent = 'Shutdown complete';
        detailsElem.textContent = details || 'Closing StormTrack Pro\u2026';
        if (quitBtn) { quitBtn.disabled = true; quitBtn.classList.add('stormTrackShutdownQuitBtn--hidden'); }
        return;
    }

    if (state === 'error') {
        hideEl(spinner);
        hideEl(checkIcon);
        showEl(warnIcon);
        if (warnIcon) { warnIcon.classList.add('stormTrackShutdownIcon--warn'); warnIcon.classList.remove('stormTrackShutdownIcon--check'); }
        status.textContent = 'Shutdown failed';
        detailsElem.textContent = details || 'The server did not stop cleanly.';
        if (quitBtn) { quitBtn.disabled = false; quitBtn.classList.remove('stormTrackShutdownQuitBtn--hidden'); }
    }
}

function bindDevAutoUpdateModeSetting() {
    const select = document.getElementById('appDevAutoUpdateModeSelect');
    if (!select || !window.stormTrackProDesktop) return;

    window.stormTrackProDesktop.getDevAutoUpdateMode().then((res) => {
        if (res && (res.mode === 'reloadWindow' || res.mode === 'restartApp' || res.mode === 'off')) {
            select.value = res.mode;
        }
    }).catch(() => {});

    select.addEventListener('change', () => {
        window.stormTrackProDesktop.setDevAutoUpdateMode(select.value).catch(() => {});
    });
}

function initDesktopLifecycleBridge() {
    if (!window.stormTrackProDesktop) return;

    window.stormTrackProDesktop.onServerLifecycleStatus((payload) => {
        if (!payload || !payload.status) return;
        setShutdownOverlayState(payload.status, payload.details);
    });

    const quitBtn = document.getElementById('stormTrackShutdownQuitBtn');
    if (quitBtn) {
        quitBtn.addEventListener('click', () => {
            quitBtn.disabled = true;
            window.stormTrackProDesktop.requestGracefulQuit().catch(() => {
                quitBtn.disabled = false;
            });
        });
    }

    bindDevAutoUpdateModeSetting();
}

module.exports = {
    initDesktopLifecycleBridge
};
