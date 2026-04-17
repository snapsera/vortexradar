const SPC_RISK_LEVEL = {
    TSTM: { num: '0', name: 'General Thunder', color: '#c1e9c1' },
    MRGL: { num: '1', name: 'Marginal', color: '#66c566' },
    SLGT: { num: '2', name: 'Slight', color: '#f6f67f' },
    ENH: { num: '3', name: 'Enhanced', color: '#e5993e' },
    MDT: { num: '4', name: 'Moderate', color: '#e5433e' },
    HIGH: { num: '5', name: 'HIGH', color: '#ff52ff' }
};

const RISK_ORDER = ['TSTM', 'MRGL', 'SLGT', 'ENH', 'MDT', 'HIGH'];
const HEADER_SOCIAL_ROTATION_MS = 4500;
const X_SVG = '<svg class="about_xSvg" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
const HEADER_SOCIAL_ENTRIES = [
    '<a class="about_socialLink about_socialLink--x" href="https://x.com/_snapsera" target="_blank" rel="noopener noreferrer">' + X_SVG + '@_snapsera</a>',
    '<a class="about_socialLink about_socialLink--github" href="https://github.com/snapsera" target="_blank" rel="noopener noreferrer"><i class="fa-brands fa-github"></i>GitHub</a>'
];

class LiveModeHeaderController {
    constructor() {
        this.socialTimer = null;
        this.socialIndex = 0;
        this.bindSocialLinkClicks();
        this.attachHeaderObserver();
    }

    setClockMode(mode) {
        var $clock = $('#headerClock');
        var $lines = $clock.find('.headerClockLine');
        if (!$clock.length) return;
        if (mode === 'site-only') {
            $lines.eq(0).hide();
            $lines.eq(1).show();
        } else if (mode === 'hidden') {
            $lines.hide();
        } else {
            $lines.show();
        }
    }

    hideRadarInfo(riskLabel, options) {
        var allowSocialFallback = !(options && options.allowSocialFallback === false);
        var $info = $('#radarInfoSpan');
        var wasVisible = $info.is(':visible');
        $info.data('lm-was-visible', wasVisible);
        $info.hide();
        var $lmHeader = $('#lmHeaderInfo');
        if (!$lmHeader.length) {
            $('<span id="lmHeaderInfo" style="font-size:14px;font-weight:600;letter-spacing:0.02em;"></span>')
                .insertAfter($info);
            $lmHeader = $('#lmHeaderInfo');
        }
        if (riskLabel) {
            this.stopHeaderSocialCycle();
            $lmHeader.html(riskLabel).show();
        } else if (allowSocialFallback && this.shouldShowSocialFallback()) {
            this.startHeaderSocialCycle($lmHeader);
        } else {
            this.stopHeaderSocialCycle();
            $lmHeader.hide().html('');
        }
    }

    showRadarInfo() {
        var $lmHeader = $('#lmHeaderInfo');
        var $info = $('#radarInfoSpan');
        var wasVisible = !!$info.data('lm-was-visible');
        var hasCurrentRadarContent = this.hasRadarContent($info);
        var isCurrentlyVisible = $info.is(':visible');
        var shouldRestoreRadar = wasVisible || (isCurrentlyVisible && hasCurrentRadarContent);
        if (shouldRestoreRadar) {
            this.stopHeaderSocialCycle();
            if ($lmHeader.length) $lmHeader.hide().html('');
            $info.show();
            return;
        }

        if (!$lmHeader.length) {
            $('<span id="lmHeaderInfo" style="font-size:14px;font-weight:600;letter-spacing:0.02em;"></span>')
                .insertAfter($info);
            $lmHeader = $('#lmHeaderInfo');
        }
        this.startHeaderSocialCycle($lmHeader);
    }

    startHeaderSocialCycle($lmHeader) {
        if (!$lmHeader || !$lmHeader.length) return;
        if (this.isRadarInfoVisible()) {
            this.stopHeaderSocialCycle();
            $lmHeader.hide().html('');
            return;
        }
        this.renderHeaderSocialEntry($lmHeader);
        if (this.socialTimer != null) return;
        this.socialTimer = setInterval(() => {
            this.socialIndex = (this.socialIndex + 1) % HEADER_SOCIAL_ENTRIES.length;
            this.renderHeaderSocialEntry($lmHeader);
        }, HEADER_SOCIAL_ROTATION_MS);
    }

    stopHeaderSocialCycle() {
        if (this.socialTimer != null) {
            clearInterval(this.socialTimer);
            this.socialTimer = null;
        }
        this.socialIndex = 0;
    }

    renderHeaderSocialEntry($lmHeader) {
        if (!$lmHeader || !$lmHeader.length) return;
        if (this.isRadarInfoVisible()) {
            this.stopHeaderSocialCycle();
            $lmHeader.hide().html('');
            return;
        }
        $lmHeader.html(HEADER_SOCIAL_ENTRIES[this.socialIndex]).show();
    }

    bindSocialLinkClicks() {
        $(document).off('click.lmHeaderSocial', '#lmHeaderInfo .about_socialLink');
        $(document).on('click.lmHeaderSocial', '#lmHeaderInfo .about_socialLink', function(e) {
            e.preventDefault();
            var href = $(this).attr('href');
            if (href) window.open(href, '_blank', 'noopener');
        });
    }

    attachHeaderObserver() {
        var target = document.getElementById('top-left');
        if (!target || this._headerObserver) return;
        this._headerObserver = new MutationObserver(() => {
            var $info = $('#radarInfoSpan');
            var $lmHeader = $('#lmHeaderInfo');
            var overlap = $info.is(':visible') && $lmHeader.is(':visible') && $lmHeader.find('.about_socialLink').length > 0;
            if (!overlap) return;
            this.stopHeaderSocialCycle();
            $lmHeader.hide().html('');
        });
        this._headerObserver.observe(target, { attributes: true, childList: true, subtree: true, characterData: true });
    }

    isRadarInfoVisible() {
        var $info = $('#radarInfoSpan');
        return !!($info.length && $info.is(':visible'));
    }

    shouldShowSocialFallback() {
        return true;
    }

    hasRadarContent($info) {
        if (!$info || !$info.length) return false;
        var station = ($('#radarStation').text() || '').trim();
        var location = ($('#radarLocation').text() || '').trim();
        var vcp = ($('#radarVCP').text() || '').trim();
        return !!(station || location || vcp);
    }

    classifyRisk(props) {
        var label = String(props.label || '').toUpperCase().trim();
        var label2 = String(props.label2 || '').toUpperCase().trim();
        var text = label + ' ' + label2;
        if (text.indexOf('HIGH') !== -1 || label === 'HIGH') return 'HIGH';
        if (text.indexOf('MODERATE') !== -1 || label === 'MDT') return 'MDT';
        if (text.indexOf('ENHANCED') !== -1 || label === 'ENH') return 'ENH';
        if (text.indexOf('SLIGHT') !== -1 || label === 'SLGT') return 'SLGT';
        if (text.indexOf('MARGINAL') !== -1 || label === 'MRGL') return 'MRGL';
        if (text.indexOf('GENERAL THUNDER') !== -1 || label === 'TSTM' || text.indexOf('THUNDERSTORM') !== -1) return 'TSTM';
        return null;
    }

    buildRiskLabel(geojson) {
        if (!geojson || !geojson.features || !geojson.features.length) return null;
        var highest = null;
        for (var i = 0; i < geojson.features.length; i++) {
            var risk = this.classifyRisk(geojson.features[i]?.properties || {});
            if (!risk) continue;
            var idx = RISK_ORDER.indexOf(risk);
            if (idx >= 0 && (!highest || idx > RISK_ORDER.indexOf(highest))) highest = risk;
        }
        if (!highest) return null;
        var info = SPC_RISK_LEVEL[highest];
        if (!info) return null;
        return '<span style="color:' + info.color + ';font-size:15px">' + info.num + '/5</span>' +
            ' <span style="color:rgba(255,255,255,0.5);font-size:12px">' + info.name + ' Risk</span>';
    }
}

module.exports = LiveModeHeaderController;
