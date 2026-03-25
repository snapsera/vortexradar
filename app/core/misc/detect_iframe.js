function in_iframe() {
    try {
        return window.self !== window.top;
    } catch (e) {
        return true;
    }
}

var _isRadarPreview = false;
try {
    _isRadarPreview = new URLSearchParams(window.location.search).get('radarPreview') === '1';
} catch (_) {}

if (in_iframe() && !_isRadarPreview) {
    $('#armrAboutBtn').click();
}