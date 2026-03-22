function init() {
    const btn = document.getElementById('fullscreenToggleBtn');
    const icon = document.getElementById('fullscreenToggleIcon');
    if (!btn || !icon) return;

    btn.addEventListener('click', () => {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            document.documentElement.requestFullscreen();
        }
    });

    document.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement) {
            icon.classList.remove('fa-expand');
            icon.classList.add('fa-compress');
            btn.title = 'Exit fullscreen';
        } else {
            icon.classList.remove('fa-compress');
            icon.classList.add('fa-expand');
            btn.title = 'Toggle fullscreen';
        }
    });
}

module.exports = { init };
