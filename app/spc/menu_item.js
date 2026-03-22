const map = require('../core/map/map');
const armFunctions = require('../core/menu/stormTrackProMenu');
const fetch_spc_data = require('./fetch_data');

var _saved_layer_visibility = null;

var _static_layer_ids = [
    'baseReflectivity',
    'station_range_layer',
    'nationalRadarLayer',
    'stationSymbolLayer',
    'alertsLayer',
    'alertsLayerFill',
    'alertsLayerOutline',
    'watches_layer',
    'watches_layer_fill',
    'watches_layer_border',
    'discussions_layer',
    'discussions_layer_fill',
    'lightningLayer',
    'metarSymbolLayer',
    'radioStationLayer',
    'pressure_points_layer'
];

function _get_all_non_spc_layer_ids() {
    var ids = _static_layer_ids.slice();
    var st = window.stormTrackData || {};
    var dynamic_arrays = [
        st.storm_track_layers,
        st.tvs_layers,
        st.stormTrackLayers,
        st.hurricane_layers,
        st.surface_fronts_layers
    ];
    for (var j = 0; j < dynamic_arrays.length; j++) {
        if (dynamic_arrays[j]) {
            ids = ids.concat(dynamic_arrays[j]);
        }
    }
    return ids;
}

function _hide_all_other_layers() {
    _saved_layer_visibility = {};
    var ids = _get_all_non_spc_layer_ids();
    for (var i = 0; i < ids.length; i++) {
        if (map.getLayer(ids[i])) {
            _saved_layer_visibility[ids[i]] = map.getLayoutProperty(ids[i], 'visibility') || 'visible';
            map.setLayoutProperty(ids[i], 'visibility', 'none');
        }
    }
    $('#mapColorScale').hide();
    $('#hurricaneLegendDiv').hide();
    $('#radarSweepContainer').hide();
}

function _restore_all_other_layers() {
    if (!_saved_layer_visibility) return;

    for (var id in _saved_layer_visibility) {
        if (map.getLayer(id)) {
            map.setLayoutProperty(id, 'visibility', _saved_layer_visibility[id]);
        }
    }

    var ids = _get_all_non_spc_layer_ids();
    for (var i = 0; i < ids.length; i++) {
        if (map.getLayer(ids[i]) && !_saved_layer_visibility.hasOwnProperty(ids[i])) {
            map.setLayoutProperty(ids[i], 'visibility', 'visible');
        }
    }

    _saved_layer_visibility = null;

    $('#mapColorScale').show();
    if ($('#armrHurricaneLegendVisBtnSwitchElem').is(':checked')) {
        $('#hurricaneLegendDiv').show();
    }
    if ($('#armrRadarSweepBtnSwitchElem').is(':checked')) {
        $('#radarSweepContainer').show();
    }
}

function _hide_spc_layers() {
    if (map.getLayer('spc_fill')) {
        map.removeLayer('spc_fill');
        map.removeLayer('spc_border');
        map.removeSource('spc_source');
    }
}

function _load_spc_toggleswitch(items_list) {
    for (var i = 0; i < items_list.length; i++) {
        const type = items_list[i][0];
        const category = items_list[i][1];
        const day = items_list[i][2];

        const elem = $(`#armrSPC_${type}-${category}-${day}_BtnSwitchElem`);

        armFunctions.toggleswitchFunctions(elem,
        function() {
            const elem = $('.spcToggleswitchBtn');
            elem.each(index => {
                elem[index].checked = false;
            });
            $(this)[0].checked = true;

            if (!_saved_layer_visibility) {
                _hide_all_other_layers();
            }

            fetch_spc_data(type, category, day);
        },
        function() {
            _hide_spc_layers();
            $('#spcLegendDiv').hide();
            _restore_all_other_layers();
        })
    }
}

_load_spc_toggleswitch([
    ['convective', 'categorical', 'day1'],
    ['convective', 'categorical', 'day2'],
    ['convective', 'categorical', 'day3'],

    ['convective', 'probabalistic', 'day3'],
    // ['convective', 'probabalistic', 'day4'],
    // ['convective', 'probabalistic', 'day5'],
    // ['convective', 'probabalistic', 'day6'],
    // ['convective', 'probabalistic', 'day7'],
    // ['convective', 'probabalistic', 'day8'],

    // ['convective', 'significant_probabalistic', 'day3'],

    ['convective', 'tornado', 'day1'],
    ['convective', 'tornado', 'day2'],
    // ['convective', 'significant_tornado', 'day1'],
    // ['convective', 'significant_tornado', 'day2'],

    ['convective', 'wind', 'day1'],
    ['convective', 'wind', 'day2'],
    // ['convective', 'significant_wind', 'day1'],
    // ['convective', 'significant_wind', 'day2'],

    ['convective', 'hail', 'day1'],
    ['convective', 'hail', 'day2'],
    // ['convective', 'significant_hail', 'day1'],
    // ['convective', 'significant_hail', 'day2'],

    // ['fire', 'dryt', 'day1'],
    // ['fire', 'dryt', 'day2'],

    // ['fire', 'dryt_categorical', 'day3'],
    // ['fire', 'dryt_probabalistic', 'day3'],

    // ['fire', 'windrh', 'day1'],
    // ['fire', 'windrh', 'day2'],
]);