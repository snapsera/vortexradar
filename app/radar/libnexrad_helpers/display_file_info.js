const nexrad_locations = require('../libnexrad/nexrad_locations').NEXRAD_LOCATIONS;
const { get_station_state } = require('../libnexrad/nexrad_locations');
const { get_date_diff } = require('../../core/misc/get_date_diff');
const { DateTime } = require('luxon');
const ut = require('../../core/utils');

var alreadyClicked = false;
function _position_footer() {
    if (!alreadyClicked) {
        alreadyClicked = true;
        $('#productMapFooter').show();
    }
}

function _display_time_diff() {
    const date_diff = get_date_diff(this.get_date(), 'radar_plot');
    const text = date_diff.formatted ? `Last scan ${date_diff.formatted} ago` : 'Last scan just now';

    $('#top-right-date').removeClass().addClass('attributionDivScanAge').html(text).show();
}

/**
 * This function is called using ".apply()", so "this" is a reference to an instance of the L3Factory class.
 */
function display_file_info() {
    _position_footer();

    // make sure the file upload stuff is hidden
    $('#fileUploadSpan').hide();
    $('#radarInfoSpan').show();

    // set some DOM content
    $('#radarStation').html(this.station);
    var radar_name = nexrad_locations[this.station]?.name;
    if (radar_name == undefined) { radar_name = 'Unknown'; }
    var radar_state = get_station_state(this.station);
    $('#radarLocation').html(radar_state ? radar_name + ', ' + radar_state : radar_name);

    var statusInfo = window.stormTrackData?.radar_station_status?.[this.station];
    var statusEl = $('#radarStationStatus');
    statusEl.removeClass('radarStationStatus-up radarStationStatus-down radarStationStatus-unknown');
    if (statusInfo) {
        statusEl.addClass(statusInfo.status === 'up' ? 'radarStationStatus-up' : 'radarStationStatus-down');
    } else {
        statusEl.addClass('radarStationStatus-unknown');
    }

    // set the date box content
    var fileDateObj;
    if (this.nexrad_level == 2) {
        fileDateObj = this.get_date(this.elevation_number);
    } else {
        fileDateObj = this.get_date();
    }
    var formattedDateObj = DateTime.fromJSDate(fileDateObj).setZone(ut.userTimeZone);
    var formattedRadarDate = formattedDateObj.toFormat('L/d/yyyy');
    var formattedRadarTime = formattedDateObj.toFormat('h:mm a ZZZZ');
    const loopState = window?.stormTrackData?.loopPlayback;
    const hideDateTimeForLoop = !!(loopState?.active && loopState?.supported);
    if (hideDateTimeForLoop) {
        $('#radarDateTime').hide().html(`${formattedRadarDate}<br>${formattedRadarTime}`);
    } else {
        $('#radarDateTime').show().html(`${formattedRadarDate}<br>${formattedRadarTime}`);
    }
    // display the time difference
    _display_time_diff.apply(this);

    // show the main box containing station name, vcp, etc.
    $('#radarInfoSpan').show();

    // show the text to open the product selection menu
    $('#productsDropdownTrigger').show();

    // display the VCP
    var radar_vcp = ut.vcpObj[this.vcp];
    if (radar_vcp == undefined) { radar_vcp = 'Unknown'; }
    $('#radarVCP').html(`VCP: ${this.vcp} (${radar_vcp})`);

    // display the elevation angle
    $('#extraProductInfo').show().html(`Elevation: ${this.elevation_angle.toFixed(1)}°`);

    if (window.stormTrackData.from_file_upload && this.nexrad_level == 3) {
        $('#productsDropdownTriggerText').hide();
    } else {
        $('#productsDropdownTriggerText').show();
    }
}

module.exports = display_file_info;