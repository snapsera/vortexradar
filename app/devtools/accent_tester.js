const DEFAULT_ACCENT = '#0ea5e9';

function _normalize_hex(input) {
    if (!input) return null;
    let hex = String(input).trim().replace(/^#/, '');
    if (hex.length === 3) {
        hex = hex.split('').map(function(ch) { return ch + ch; }).join('');
    }
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
    return ('#' + hex).toLowerCase();
}

function _hex_to_rgb(hex) {
    const value = parseInt(hex.slice(1), 16);
    return {
        r: (value >> 16) & 255,
        g: (value >> 8) & 255,
        b: value & 255
    };
}

function _rgb_to_hex(r, g, b) {
    const toHex = function(channel) {
        const clamped = Math.max(0, Math.min(255, Math.round(channel)));
        return clamped.toString(16).padStart(2, '0');
    };
    return '#' + toHex(r) + toHex(g) + toHex(b);
}

function _lighten_hex(hex, amount) {
    const rgb = _hex_to_rgb(hex);
    return _rgb_to_hex(
        rgb.r + (255 - rgb.r) * amount,
        rgb.g + (255 - rgb.g) * amount,
        rgb.b + (255 - rgb.b) * amount
    );
}

function _apply_accent(hex) {
    const rgb = _hex_to_rgb(hex);
    const root = document.documentElement;
    root.style.setProperty('--color-accent', hex);
    root.style.setProperty('--color-accent-hover', _lighten_hex(hex, 0.25));
    root.style.setProperty('--color-accent-muted', 'rgba(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ', 0.12)');
}

function _wire_button() {
    const button = document.getElementById('devAccentColorTestBtn');
    if (!button) return;

    button.addEventListener('click', function() {
        const current = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() || DEFAULT_ACCENT;
        const input = window.prompt('Enter accent hex color (example: 0ea5e9). Type "reset" to restore default.', current);
        if (input == null) return;

        if (input.trim().toLowerCase() === 'reset') {
            _apply_accent(DEFAULT_ACCENT);
            return;
        }

        const normalized = _normalize_hex(input);
        if (!normalized) {
            window.alert('Invalid color. Use 3 or 6-digit hex (for example: #0ea5e9).');
            return;
        }

        _apply_accent(normalized);
    });
}

_wire_button();
