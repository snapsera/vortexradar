const ut = require('../utils');
const map = require('../map/map');
const armFunctions = require('./stormTrackProMenu');
const setLayerOrder = require('../map/setLayerOrder');
const fetchMETARData = require('../../metars/fetch_data');
const fetch_alerts_data = require('../../alerts/fetch_data');
const apply_alerts_display = require('../../alerts/apply_visibility').apply_alerts_display;
const fetch_spc_data = require('../../spc/fetch_data');
const change_map_style = require('../map/styles');
const settings_store = require('./settings_store');
const station_markers = require('../../radar/station_markers/station_markers');
const radar_scan_animation = require('../../radar/station_markers/radar_scan_animation');
const national_radar_layer = require('../../radar/national/national_radar_layer');
const nexrad_locations = require('../../radar/libnexrad/nexrad_locations').NEXRAD_LOCATIONS;
const product_colors = require('../../radar/colormaps/colormaps');
const create_and_show_colorbar = require('../../radar/plot/create_and_show_colorbar');
const chroma = require('chroma-js');

const divElem = '#settingsItemDiv';
const iconElem = '#settingsItemClass';

function saveSettings() {
    const settings = settings_store.get_settings_from_dom();
    settings_store.save(settings);
}

function setRadarVisibility(isVisible) {
    const visibility = isVisible ? 'visible' : 'none';
    if (map.getLayer('baseReflectivity')) {
        map.setLayoutProperty('baseReflectivity', 'visibility', visibility);
    }
    if (map.getLayer('station_range_layer')) {
        var radiusEnabled = $('#armrRadarRadiusBtnSwitchElem').is(':checked');
        map.setLayoutProperty('station_range_layer', 'visibility', (isVisible && radiusEnabled) ? 'visible' : 'none');
    }
    if (map.getLayer('nationalRadarLayer')) {
        map.setLayoutProperty('nationalRadarLayer', 'visibility', visibility);
    }
}

function setStationAndProductControlsDisabled(disabled) {
    const opacity = disabled ? '0.45' : '';
    const pointerEvents = disabled ? 'none' : '';
    $('#stationMenuItemDiv').css({ opacity, pointerEvents });
    $('#productsDropdownTrigger').css({ opacity, pointerEvents });
}

function setStationMarkerVisibility(isVisible) {
    if (!map.getLayer('stationSymbolLayer')) return;
    map.setLayoutProperty('stationSymbolLayer', 'visibility', isVisible ? 'visible' : 'none');
}

function showSingleSiteReflectivityColorbar() {
    const reflectivity = product_colors.N0B;
    if (!reflectivity?.colors || !reflectivity?.values) return;
    const scaledValues = ut.scaleValues([...reflectivity.values], 'N0B');
    window.stormTrackData.colorscale_cmin = scaledValues[0];
    window.stormTrackData.colorscale_cmax = scaledValues[scaledValues.length - 1];
    window.stormTrackData.webgl_chroma_scale = chroma.scale(reflectivity.colors).domain(scaledValues).mode('lab');
    create_and_show_colorbar(reflectivity.colors, scaledValues);
}

function applyUSRadarMode(enabled) {
    window.stormTrackData.usRadarEnabled = !!enabled;
    setStationAndProductControlsDisabled(enabled);

    if (enabled) {
        if (window?.stormTrackData?.current_RadarUpdater != undefined) {
            window.stormTrackData.current_RadarUpdater.disable();
        }

        if (map.getLayer('baseReflectivity')) {
            map.removeLayer('baseReflectivity');
        }
        if (map.getLayer('station_range_layer')) {
            map.removeLayer('station_range_layer');
        }
        if (map.getSource('station_range_source')) {
            map.removeSource('station_range_source');
        }

        window.stormTrackData.usRadarPrevStationMarkersVisible = $('#dataDiv').data('stationMarkersVisible');
        setStationMarkerVisibility(false);
        $('#productMapFooter').hide();
        national_radar_layer.enable();
        showSingleSiteReflectivityColorbar();
        $('#radarInfoSpan').show();
        $('#radarStation').html('CONUS MRMS');
        $('#radarLocation').html('MRMS Base Reflectivity Mosaic');
        return;
    }

    national_radar_layer.disable();
    $('#productMapFooter').show();
    const shouldShowStations = window.stormTrackData.usRadarPrevStationMarkersVisible !== false;
    setStationMarkerVisibility(shouldShowStations);

    const saved = settings_store.load();
    const stationId = window.stormTrackData.currentStation || saved.currentStation;
    if (stationId && nexrad_locations[stationId]) {
        const stationType = nexrad_locations[stationId].type || 'WSR-88D';
        station_markers.selectStation(stationId, stationType);
    }
}

if ($(iconElem).length) {
    $(iconElem).on('click', function() {
        armFunctions.showARMwindow();
    });
}

$('#armrSTVisBtnSwitchElem').on('click', function() {
    var isChecked = $(this).is(':checked');
    $('#dataDiv').data('stormTracksVisibility', isChecked);

    var st_layers = window.stormTrackData.storm_track_layers;
    var tvs_layers = window.stormTrackData.tvs_layers;
    if (!isChecked) {
        for (var item in st_layers) {
            map.setLayoutProperty(st_layers[item], 'visibility', 'none');
        }
        for (var item in tvs_layers) {
            map.setLayoutProperty(tvs_layers[item], 'visibility', 'none');
        }
    } else if (isChecked) {
        for (var item in st_layers) {
            map.setLayoutProperty(st_layers[item], 'visibility', 'visible');
        }
        for (var item in tvs_layers) {
            map.setLayoutProperty(tvs_layers[item], 'visibility', 'visible');
        }
    }
    saveSettings();
})

armFunctions.toggleswitchFunctions($('#armrRadarVisBtnSwitchElem'), function() {
    setRadarVisibility(true);
}, function() {
    setRadarVisibility(false);
}, saveSettings)

function applyRadarOpacity(val) {
    const opacity = val / 100;
    window.stormTrackData.radarOpacity = opacity;
    if (map.getLayer('nationalRadarLayer')) {
        map.setPaintProperty('nationalRadarLayer', 'raster-opacity', opacity);
    }
    // station radar picks up the value from window.stormTrackData.radarOpacity each frame
    if (map.getLayer('baseReflectivity')) {
        map.triggerRepaint();
    }
}

$('#armrRadarOpacitySlider').on('input', function() {
    var val = parseInt($(this).val(), 10);
    $('#armrRadarOpacityValue').text(val + '%');
    applyRadarOpacity(val);
});
$('#armrRadarOpacitySlider').on('change', function() {
    saveSettings();
});

function updateGateFilterTrack() {
    var min = parseInt($('#gateFilterMinSlider').val(), 10);
    var max = parseInt($('#gateFilterMaxSlider').val(), 10);
    var rangeMin = -10;
    var rangeSpan = 85 - rangeMin;
    var leftPct = ((min - rangeMin) / rangeSpan) * 100;
    var rightPct = ((85 - max) / rangeSpan) * 100;
    $('#gateFilterTrack').css({
        '--track-left': leftPct + '%',
        '--track-right': rightPct + '%'
    });
}

function updateGateFilterNote(minVal, maxVal) {
    if (minVal < 10 || maxVal < 85) {
        $('#gateFilterNote').show();
    } else {
        $('#gateFilterNote').hide();
    }
}

function applyGateFilter(minVal, maxVal) {
    window.stormTrackData.gateFilterMin = minVal;
    window.stormTrackData.gateFilterMax = maxVal;
    updateGateFilterNote(minVal, maxVal);
    if (map.getLayer('baseReflectivity')) {
        map.triggerRepaint();
    }
}

$('#gateFilterMinSlider').on('input', function() {
    var minVal = parseInt($(this).val(), 10);
    var maxVal = parseInt($('#gateFilterMaxSlider').val(), 10);
    if (minVal > maxVal) { $(this).val(maxVal); minVal = maxVal; }
    $('#gateFilterMinValue').text(minVal);
    updateGateFilterTrack();
    applyGateFilter(minVal, maxVal);
});
$('#gateFilterMaxSlider').on('input', function() {
    var maxVal = parseInt($(this).val(), 10);
    var minVal = parseInt($('#gateFilterMinSlider').val(), 10);
    if (maxVal < minVal) { $(this).val(minVal); maxVal = minVal; }
    $('#gateFilterMaxValue').text(maxVal);
    updateGateFilterTrack();
    applyGateFilter(minVal, maxVal);
});
$('#gateFilterMinSlider').on('change', saveSettings);
$('#gateFilterMaxSlider').on('change', saveSettings);

function applyAlertFillOpacity(val) {
    const opacity = val / 100;
    window.stormTrackData.alertFillOpacity = opacity;
    if (map.getLayer('alertsLayerFill')) map.setPaintProperty('alertsLayerFill', 'fill-opacity', opacity);
    if (map.getLayer('watches_layer_fill')) map.setPaintProperty('watches_layer_fill', 'fill-opacity', opacity);
    if (map.getLayer('discussions_layer_fill')) map.setPaintProperty('discussions_layer_fill', 'fill-opacity', opacity);
}

function _buildAlertLineWidth(scale) {
    return [
        'case',
        ['==', ['get', 'type'], 'outline'],
        ['case', ['>=', ['index-of', 'Watch', ['get', 'event']], 0], 2 * scale, 3 * scale],
        ['==', ['get', 'type'], 'border'],
        ['case', ['>=', ['index-of', 'Watch', ['get', 'event']], 0], 4 * scale, 7 * scale],
        0
    ];
}

function _buildDiscussionLineWidth(scale) {
    return [
        'case',
        ['==', ['get', 'type'], 'outline'], 3 * scale,
        ['==', ['get', 'type'], 'border'], 7 * scale,
        0
    ];
}

function applyAlertBorderScale(val) {
    const scale = val / 100;
    window.stormTrackData.alertBorderScale = scale;
    if (map.getLayer('alertsLayer')) map.setPaintProperty('alertsLayer', 'line-width', _buildAlertLineWidth(scale));
    if (map.getLayer('alertsBlinkLayer')) map.setPaintProperty('alertsBlinkLayer', 'line-width', 14 * scale);
    if (map.getLayer('watches_layer_border')) map.setPaintProperty('watches_layer_border', 'line-width', 2.4 * scale);
    if (map.getLayer('watches_layer')) map.setPaintProperty('watches_layer', 'line-width', 1.2 * scale);
    if (map.getLayer('discussions_layer')) map.setPaintProperty('discussions_layer', 'line-width', _buildDiscussionLineWidth(scale));
}

function applyAlertBlinkColor(val) {
    window.stormTrackData.alertBlinkColor = val;
    if (map.getLayer('alertsBlinkLayer')) map.setPaintProperty('alertsBlinkLayer', 'line-color', val);
}

function applyAlertBlinkEnabled(val) {
    window.stormTrackData.alertBlinkEnabled = val;
}

function applyAlertBlinkDuration(val) {
    window.stormTrackData.alertBlinkDuration = val;
}

$('#alertFillOpacitySlider').on('input', function() {
    var val = parseInt($(this).val(), 10);
    $('#alertFillOpacityValue').text(val + '%');
    applyAlertFillOpacity(val);
});
$('#alertFillOpacitySlider').on('change', saveSettings);

$('#alertBorderScaleSlider').on('input', function() {
    var val = parseInt($(this).val(), 10);
    $('#alertBorderScaleValue').text(val + '%');
    applyAlertBorderScale(val);
});
$('#alertBorderScaleSlider').on('change', saveSettings);

$('#alertBlinkColorPicker').on('input', function() {
    applyAlertBlinkColor($(this).val());
});
$('#alertBlinkColorPicker').on('change', saveSettings);

armFunctions.toggleswitchFunctions($('#alertBlinkEnabledSwitchElem'), function() {
    applyAlertBlinkEnabled(true);
}, function() {
    applyAlertBlinkEnabled(false);
}, saveSettings);

$('#alertBlinkDurationSelect').on('change', function() {
    applyAlertBlinkDuration(parseInt($(this).val(), 10));
    saveSettings();
});

armFunctions.toggleswitchFunctions($('#armrLightningVisBtnSwitchElem'), function() {
    if (map.getLayer('lightningLayer')) {
        map.setLayoutProperty('lightningLayer', 'visibility', 'visible');
    }
}, function() {
    if (map.getLayer('lightningLayer')) {
        map.setLayoutProperty('lightningLayer', 'visibility', 'none');
    }
}, saveSettings)

armFunctions.toggleswitchFunctions($('#armrSTVisBtnSwitchElem'), function() {
    var stormTrackLayers = window.stormTrackData.stormTrackLayers;
    if (stormTrackLayers != undefined) {
        for (var i in stormTrackLayers) {
            if (map.getLayer(stormTrackLayers[i])) {
                map.setLayoutProperty(stormTrackLayers[i], 'visibility', 'visible');
            }
        }
    }
}, function() {
    var stormTrackLayers = window.stormTrackData.stormTrackLayers;
    if (stormTrackLayers != undefined) {
        for (var i in stormTrackLayers) {
            if (map.getLayer(stormTrackLayers[i])) {
                map.setLayoutProperty(stormTrackLayers[i], 'visibility', 'none');
            }
        }
    }
}, saveSettings)

armFunctions.toggleswitchFunctions($('#armrRadarSiteLegacyStyleBtnSwitchElem'), function() {
    station_markers.setStationMarkerStyle(true);
}, function() {
    station_markers.setStationMarkerStyle(false);
}, saveSettings)

armFunctions.toggleswitchFunctions($('#armrRadarSweepBtnSwitchElem'), function() {
    var currentStation = window.stormTrackData?.currentStation;
    if (currentStation) radar_scan_animation.update(currentStation);
}, function() {
    radar_scan_animation.remove();
}, saveSettings)

armFunctions.toggleswitchFunctions($('#armrRadarRadiusBtnSwitchElem'), function() {
    if (map.getLayer('station_range_layer')) {
        map.setLayoutProperty('station_range_layer', 'visibility', 'visible');
    }
}, function() {
    if (map.getLayer('station_range_layer')) {
        map.setLayoutProperty('station_range_layer', 'visibility', 'none');
    }
}, saveSettings)

$('.map_style_button').click(function() {
    $('.map_style_button').not(this).each(function() { this.checked = false; });
    saveSettings();
})
armFunctions.toggleswitchFunctions($('#armrSatelliteMapBtnSwitchElem'), function() { change_map_style('satellite'); }, function() {}, saveSettings)
armFunctions.toggleswitchFunctions($('#armrLightMapBtnSwitchElem'), function() { change_map_style('light'); }, function() {}, saveSettings)
armFunctions.toggleswitchFunctions($('#armrDarkMapBtnSwitchElem'), function() { change_map_style('dark'); }, function() {}, saveSettings)

armFunctions.toggleswitchFunctions($('#armrFocusNewAlertsBtnSwitchElem'), function() {
    // Focus New Alerts enabled - no immediate action
}, function() {
    require('../../alerts/focus_new_alerts').hide_focus_panel();
}, saveSettings);

armFunctions.toggleswitchFunctions($('#armrAudibleAlertsBtnSwitchElem'), function() {}, function() {}, saveSettings);

$('#ttsVolumeSlider').on('input', function() {
    var val = parseInt($(this).val(), 10);
    $('#ttsVolumeValue').text(val + '%');
    saveSettings();
});

armFunctions.toggleswitchFunctions($('#tornadoBeepEnabledSwitchElem'), function() {}, function() {}, saveSettings);

var audible_alerts = require('../../ui/audible_alerts');

$('#tornadoBeepVolumeSlider').on('input', function() {
    var val = parseInt($(this).val(), 10);
    $('#tornadoBeepVolumeValue').text(val + '%');
    audible_alerts.setVolume(val);
    saveSettings();
});

$('#tornadoBeepTestBtn').on('click', function() {
    audible_alerts.testTornadoWarningBeep();
});

armFunctions.toggleswitchFunctions($('#armrHurricaneLegendVisBtnSwitchElem'), function() {
    const is_hurricanes_enabled = $('#armrHurricanesBtnSwitchElem').is(':checked');
    if (is_hurricanes_enabled) {
        $('#hurricaneLegendDiv').show();
    }
}, function() {
    const is_hurricanes_enabled = $('#armrHurricanesBtnSwitchElem').is(':checked');
    if (is_hurricanes_enabled) {
        $('#hurricaneLegendDiv').hide();
    }
})

function applySavedSettings() {
    const s = settings_store.load();

    // Set checkbox states
    $('#armrRadarVisBtnSwitchElem').prop('checked', s.radar);
    $('#armrUsRadarBtnSwitchElem').prop('checked', false);
    $('#armrRadarOpacitySlider').val(s.radarOpacity);
    $('#armrRadarOpacityValue').text(s.radarOpacity + '%');
    applyRadarOpacity(s.radarOpacity);
    $('#gateFilterMinSlider').val(s.gateFilterMin);
    $('#gateFilterMaxSlider').val(s.gateFilterMax);
    $('#gateFilterMinValue').text(s.gateFilterMin);
    $('#gateFilterMaxValue').text(s.gateFilterMax);
    updateGateFilterTrack();
    applyGateFilter(s.gateFilterMin, s.gateFilterMax);
    $('#armrSTVisBtnSwitchElem').prop('checked', s.stormTracks);
    $('#armrLightningVisBtnSwitchElem').prop('checked', s.lightning);
    $('#armrRadarSiteLegacyStyleBtnSwitchElem').prop('checked', s.radarSiteLegacyStyle);
    $('#armrRadarSweepBtnSwitchElem').prop('checked', s.radarSweep);
    $('#armrRadarRadiusBtnSwitchElem').prop('checked', s.radarRadius);
    $('#armrFocusNewAlertsBtnSwitchElem').prop('checked', s.focusNewAlerts);
    $('#armrAudibleAlertsBtnSwitchElem').prop('checked', s.audibleAlerts);
    $('#ttsVolumeSlider').val(s.ttsVolume);
    $('#ttsVolumeValue').text(s.ttsVolume + '%');
    $('#tornadoBeepEnabledSwitchElem').prop('checked', s.tornadoWarningBeep);
    $('#tornadoBeepVolumeSlider').val(s.tornadoWarningBeepVolume);
    $('#tornadoBeepVolumeValue').text(s.tornadoWarningBeepVolume + '%');
    // Map style (mutually exclusive)
    $('.map_style_button').prop('checked', false);
    $('#armrDarkMapBtnSwitchElem').prop('checked', s.mapStyle === 'dark');
    $('#armrLightMapBtnSwitchElem').prop('checked', s.mapStyle === 'light');
    $('#armrSatelliteMapBtnSwitchElem').prop('checked', s.mapStyle === 'satellite');

    // Apply map style
    change_map_style(s.mapStyle);

    // Apply layer visibility
    $('#dataDiv').data('stormTracksVisibility', s.stormTracks);
    applyUSRadarMode(false);
    setRadarVisibility(s.radar);
    if (map.getLayer('lightningLayer')) {
        map.setLayoutProperty('lightningLayer', 'visibility', s.lightning ? 'visible' : 'none');
    }
    var st_layers = window.stormTrackData.storm_track_layers;
    var tvs_layers = window.stormTrackData.tvs_layers;
    if (st_layers) {
        for (var item in st_layers) {
            map.setLayoutProperty(st_layers[item], 'visibility', s.stormTracks ? 'visible' : 'none');
        }
    }
    if (tvs_layers) {
        for (var item in tvs_layers) {
            map.setLayoutProperty(tvs_layers[item], 'visibility', s.stormTracks ? 'visible' : 'none');
        }
    }
    var stormTrackLayers = window.stormTrackData.stormTrackLayers;
    if (stormTrackLayers) {
        for (var i in stormTrackLayers) {
            if (map.getLayer(stormTrackLayers[i])) {
                map.setLayoutProperty(stormTrackLayers[i], 'visibility', s.stormTracks ? 'visible' : 'none');
            }
        }
    }
    $('#alertFillOpacitySlider').val(s.alertFillOpacity);
    $('#alertFillOpacityValue').text(s.alertFillOpacity + '%');
    applyAlertFillOpacity(s.alertFillOpacity);
    $('#alertBorderScaleSlider').val(s.alertBorderScale);
    $('#alertBorderScaleValue').text(s.alertBorderScale + '%');
    applyAlertBorderScale(s.alertBorderScale);
    $('#alertBlinkColorPicker').val(s.alertBlinkColor);
    applyAlertBlinkColor(s.alertBlinkColor);
    $('#alertBlinkEnabledSwitchElem').prop('checked', s.alertBlinkEnabled);
    applyAlertBlinkEnabled(s.alertBlinkEnabled);
    $('#alertBlinkDurationSelect').val(String(s.alertBlinkDuration));
    applyAlertBlinkDuration(s.alertBlinkDuration);
    if (!s.focusNewAlerts) {
        require('../../alerts/focus_new_alerts').hide_focus_panel();
    }
    station_markers.setStationMarkerStyle(s.radarSiteLegacyStyle);
    if (!s.radarSweep) {
        radar_scan_animation.remove();
    }
    apply_alerts_display();
}

// Restore saved settings on load (defer so map and DOM are ready)
setTimeout(function() {
    applySavedSettings();
}, 0);

// Re-apply layer visibility after async data (alerts, watches, discussions) may have loaded
setTimeout(function() {
    apply_alerts_display();
}, 3000);

// armFunctions.toggleswitchFunctions($('#armrUSAMETARSSwitchElem'), function() {
//     fetchMETARData.fetchMETARData();
// }, function() {
//     fetchMETARData.fetchMETARData();
// })

// this is in app/alerts/drawAlertShapes.js
//$('#showExtraAlertPolygonsCheckbox').on('click', function() {})

// armFunctions.toggleswitchFunctions($('#armrSPCOutlooksVisBtnSwitchElem'), function() {
//     if (map.getLayer('spc_fill')) {
//         map.setLayoutProperty('spc_fill', 'visibility', 'visible');
//         map.setLayoutProperty('spc_border', 'visibility', 'visible');
//     } else {
//         fetch_spc_data();
//     }
// }, function() {
//     if (map.getLayer('spc_fill')) {
//         map.setLayoutProperty('spc_fill', 'visibility', 'none');
//         map.setLayoutProperty('spc_border', 'visibility', 'none');
//     }
// })