const display_app_dialog = require('../menu/app_dialog');

const X_SVG = '<svg class="about_xSvg" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
const DISCORD_BUTTON_ENABLED = false;
const DISCORD_SOCIAL_LINK_HTML = `
        <a class="about_socialLink about_socialLink--discord" href="https://discord.gg/wn8FMHC26v">
            <i class="fa-brands fa-discord"></i>
            Discord
        </a>`;

function build_about_html() {
    const year = new Date().getFullYear();

    return `
<div class="about">
    <div class="about_shell">
        <div class="about_hero">
            <img class="about_logo" src="images/vortexicon_rotate.svg" draggable="false" oncontextmenu="return false;">
            <div>
                <div class="about_name">Vortex Radar</div>
                <div class="about_tagline">Real-time radar at your fingertips</div>
            </div>
        </div>

        <p class="about_desc">
            Direct access to the full NEXRAD radar network, severe weather alerts,
            storm tracking, and more. Whether you're chasing storms or
            just keeping an eye on the weather, it's built to give you the data you
            need, fast. <span class="about_descAccent">COMPLETELY FREE!</span>
        </p>

        <div class="about_section">
            <div class="about_sectionLabel">What's Inside</div>
            <div class="about_featureGrid">
                <div class="about_feat">
                    <div class="about_featIcon"><i class="fa-solid fa-satellite-dish"></i></div>
                    <div>
                        <div class="about_featTitle">NEXRAD Radar</div>
                        <div class="about_featSub">Level II &amp; III with super resolution</div>
                    </div>
                </div>
                <div class="about_feat">
                    <div class="about_featIcon about_featIcon--green"><i class="fa-solid fa-wind"></i></div>
                    <div>
                        <div class="about_featTitle">Velocity Dealiasing</div>
                        <div class="about_featSub">Doppler velocity processing</div>
                    </div>
                </div>
                <div class="about_feat">
                    <div class="about_featIcon about_featIcon--amber"><i class="fa-solid fa-triangle-exclamation"></i></div>
                    <div>
                        <div class="about_featTitle">Weather Alerts</div>
                        <div class="about_featSub">Real-time NWS polygon map overlays</div>
                    </div>
                </div>
                <div class="about_feat">
                    <div class="about_featIcon about_featIcon--purple"><i class="fa-solid fa-radio"></i></div>
                    <div>
                        <div class="about_featTitle">Weather Radio</div>
                        <div class="about_featSub">NOAA live streams</div>
                    </div>
                </div>
                <div class="about_feat">
                    <div class="about_featIcon about_featIcon--pink"><i class="fa-solid fa-palette"></i></div>
                    <div>
                        <div class="about_featTitle">SPC Outlooks</div>
                        <div class="about_featSub">Convective outlook overlays and risk zones</div>
                    </div>
                </div>
                <div class="about_feat">
                <div class="about_featIcon about_featIcon--red"><i class="fa-solid fa-bolt"></i></div>
                <div>
                    <div class="about_featTitle">Live Mode</div>
                    <div class="about_featSub">Storm coverage as it happens in real time.</div>
                </div>
            </div>
            </div>
        </div>

        <div class="about_metaRow">
            <div class="about_metaCol">
                <div class="about_sectionLabel">Data Sources</div>
                <div class="about_tagRow">
                    <span class="about_tag">NWS</span>
                    <span class="about_tag">NOAA NEXRAD</span>
                    <span class="about_tag">Storm Prediction Center</span>
                    <span class="about_tag">Unidata</span>
                </div>
            </div>
            <div class="about_metaCol">
                <div class="about_sectionLabel">Built With</div>
                <div class="about_tagRow">
                    <span class="about_tag">Mapbox GL</span>
                    <span class="about_tag">WebGL</span>
                    <span class="about_tag">Node.js</span>
                </div>
            </div>
        </div>

        <div class="about_socials">
            ${DISCORD_BUTTON_ENABLED ? DISCORD_SOCIAL_LINK_HTML : ''}
            <a class="about_socialLink about_socialLink--x" href="https://x.com/_snapsera">
                ${X_SVG}
                @_snapsera
            </a>
            <a class="about_socialLink about_socialLink--github" href="https://github.com/snapsera">
                <i class="fa-brands fa-github"></i>
                GitHub
            </a>
        </div>

        <div class="about_footer">
            <span>&copy; ${year} Vortex Radar</span>
            <span class="about_uid">UID: 232292307833978881</span>
        </div>
    </div>
</div>`;
}

$('#armrAboutBtn').click(function() {
    $('#appDialogContainer').addClass('appDialog-about');
    display_app_dialog({
        title: 'About',
        subtitle: 'Platform Overview',
        body: build_about_html(),
        color: '#2563eb',
        textColor: '#ecfeff',
    });
});

$(document).on('click', '.about_socialLink', function(e) {
    e.preventDefault();
    var href = $(this).attr('href');
    window.open(href, '_blank', 'noopener');
});

$('#appDialog').on('click', function(e) {
    if ($(e.target).closest('#appDialogClose').length || $(e.target).attr('id') === 'appDialog') {
        $('#appDialogContainer').removeClass('appDialog-about');
    }
});
