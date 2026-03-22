const display_app_dialog = require('../menu/app_dialog');

function build_about_html() {
    const year = new Date().getFullYear();

    return `
<div class="about">
    <div class="about_header">
        <img class="about_logo" src="images/STP_icon.svg" draggable="false" oncontextmenu="return false;">
        <div class="about_titleBlock">
            <div class="about_name">StormTrack Pro</div>
        </div>
    </div>

    <p class="about_desc">
        Direct access to the full NEXRAD radar network, severe weather alerts,
        storm tracking, and a whole lot more. Whether you're chasing storms or
        just keeping an eye on the weather, it's built to give you the data you
        need, fast.
    </p>

    <div class="about_divider"></div>

    <div class="about_section">
        <div class="about_sectionLabel">What's inside</div>
        <div class="about_featureList">
            <div class="about_feat"><i class="fa-solid fa-satellite-dish about_featDot"></i>Full NEXRAD Level II &amp; III radar products with super resolution</div>
            <div class="about_feat"><i class="fa-solid fa-wind about_featDot"></i>Doppler velocity dealiasing</div>
            <div class="about_feat"><i class="fa-solid fa-triangle-exclamation about_featDot"></i>Real-time NWS weather alerts with polygon map overlays</div>
            <div class="about_feat"><i class="fa-solid fa-bolt-lightning about_featDot"></i>Lightning strike tracking</div>
            <div class="about_feat"><i class="fa-solid fa-cloud-bolt about_featDot"></i>SPC convective outlooks &mdash; categorical, tornado, wind, hail</div>
            <div class="about_feat"><i class="fa-solid fa-route about_featDot"></i>Storm tracks with automated projections</div>
            <div class="about_feat"><i class="fa-solid fa-radio about_featDot"></i>NOAA Weather Radio live streams</div>
            <div class="about_feat"><i class="fa-solid fa-palette about_featDot"></i>Custom colortables with upload support</div>
        </div>
    </div>

    <div class="about_divider"></div>

    <div class="about_bottomRow">
        <div class="about_bottomCol">
            <div class="about_sectionLabel">Data sources</div>
            <div class="about_tagRow">
                <span class="about_tag">NWS</span>
                <span class="about_tag">NOAA NEXRAD</span>
                <span class="about_tag">Storm Prediction Center</span>
                <span class="about_tag">Unidata</span>
            </div>
        </div>
        <div class="about_bottomCol">
            <div class="about_sectionLabel">Built with</div>
            <div class="about_tagRow">
                <span class="about_tag">Electron</span>
                <span class="about_tag">Mapbox GL</span>
                <span class="about_tag">WebGL</span>
                <span class="about_tag">Node.js</span>
            </div>
        </div>
    </div>

    <div class="about_discord">
        <a class="about_discordLink" href="https://discord.gg/wn8FMHC26v">
            <i class="fa-brands fa-discord about_discordIcon"></i>
            Join our Discord
        </a>
    </div>

    <div class="about_footer">&copy; ${year} StormTrack Pro</div>
</div>`;
}

$('#armrAboutBtn').click(function() {
    $('#appDialogContainer').addClass('appDialog-about');
    display_app_dialog({
        title: 'About',
        subtitle: ' ',
        body: build_about_html(),
        color: '#13161e',
        textColor: '#e2e8f0',
    });
});

$(document).on('click', '.about_discordLink', function(e) {
    e.preventDefault();
    if (window.stormTrackProDesktop && window.stormTrackProDesktop.openExternalUrl) {
        window.stormTrackProDesktop.openExternalUrl($(this).attr('href'));
    }
});

$('#appDialog').on('click', function(e) {
    if ($(e.target).closest('#appDialogClose').length || $(e.target).attr('id') === 'appDialog') {
        $('#appDialogContainer').removeClass('appDialog-about');
    }
});
