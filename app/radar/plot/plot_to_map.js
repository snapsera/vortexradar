const product_colors = require('../colormaps/colormaps');
const ut = require('../../core/utils')
const map_funcs = require('../../core/map/mapFunctions');
const setLayerOrder = require('../../core/map/setLayerOrder');
const create_and_show_colorbar = require('./create_and_show_colorbar');
const create_WebGL_texture = require('./create_WebGL_texture');
const vertex_source = require('./glsl/vertex.glsl');
const fragment_source = require('./glsl/fragment.glsl');
const fragment_framebuffer_source = require('./glsl/fragment_framebuffer.glsl');
const map = require('../../core/map/map');
const RadarUpdater = require('../updater/RadarUpdater');
const turf = require('@turf/turf');
const radar_scan_animation = require('../station_markers/radar_scan_animation');

var _previousScanData = null;
var _sweepRevealState = {
    active: false,
    startAngle: 0,
    startTime: 0,
    oldVertexCount: 0,
};
var TWO_PI = Math.PI * 2;
var _pendingBufferUpdate = null;

function plot_to_map(verticies_arr, colors_arr, product, nexrad_factory) {
    _pendingBufferUpdate = null;
    var color_scale_data = product_colors[product];
    var colors = [...color_scale_data.colors];
    var values = [...color_scale_data.values];

    const location = nexrad_factory.get_location();
    const radar_lat_lng = { lat: location[0], lng: location[1] }

    var radarMercX = (180 + radar_lat_lng.lng) / 360;
    var radarMercY = (180 - (180 / Math.PI * Math.log(Math.tan(Math.PI / 4 + radar_lat_lng.lat * Math.PI / 360)))) / 360;

    var sweepActive = radar_scan_animation.is_active();
    var sameStation = _previousScanData &&
        _previousScanData.radarLat === radar_lat_lng.lat &&
        _previousScanData.radarLng === radar_lat_lng.lng;
    var doSweepReveal = sweepActive && sameStation && window.stormTrackData._sweepRevealNextPlot;
    window.stormTrackData._sweepRevealNextPlot = false;

    var oldVertexF32 = doSweepReveal ? _previousScanData.vertices : null;
    var oldColorF32 = doSweepReveal ? _previousScanData.colors : null;
    var oldVertexCount = doSweepReveal ? _previousScanData.vertexCount : 0;
    var sweepStartAngle = 0;
    var sweepStartTime = 0;
    if (doSweepReveal) {
        var now = performance.now();
        var SWEEP_PERIOD = radar_scan_animation.get_sweep_period_ms();
        sweepStartAngle = (now % SWEEP_PERIOD) / SWEEP_PERIOD * TWO_PI;
        sweepStartTime = now;
    }

    // add range folded colors
    if (color_scale_data.hasOwnProperty('range_fold')) {
        colors.push(color_scale_data.range_fold);
        values.push(product_colors.range_folded_val);
    }

    values = ut.scaleValues(values, product);
    const cmin = values[0];
    window.stormTrackData.cmin = cmin;
    window.stormTrackData.colorscale_cmin = cmin;
    const cmax = values[values.length - 1];
    window.stormTrackData.cmax = cmax;
    window.stormTrackData.colorscale_cmax = cmax;
    if (color_scale_data.hasOwnProperty('range_fold')) {
        const colorscale_cmax = values[values.length - 2];
        window.stormTrackData.colorscale_cmax = colorscale_cmax;
    }

    //var vertexF32 = new Float32Array(verticiesArr);
    //var colorF32 = new Float32Array(colorsArr);
    var vertexF32 = verticies_arr;
    var colorF32 = colors_arr;

    var imagedata;
    var imagetexture;
    let _renderFrameCount = 0;
    let _renderAccumMs = 0;

    var fb;
    function createFramebuffer(gl) {
        const targetTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, targetTexture);

        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.drawingBufferWidth, gl.drawingBufferHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        window.stormTrackData.fb = gl.createFramebuffer();

        gl.bindFramebuffer(gl.FRAMEBUFFER, window.stormTrackData.fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, targetTexture, 0);
    }
    function renderToFramebuffer(gl, matrix) {
        gl.useProgram(this.programFramebuffer);

        // set uniforms for the framebuffer shaders
        gl.uniformMatrix4fv(this.matrixLocationFramebuffer, false, matrix);
        gl.uniform2fv(this.radarLngLatLocationFramebuffer, [radar_lat_lng.lat, radar_lat_lng.lng]);
        gl.uniform2fv(this.minmaxLocationFramebuffer, [cmin, cmax]);
        gl.uniform2fv(this.radarMercLocationFramebuffer, [radarMercX, radarMercY]);
        // render to the framebuffer
        gl.bindFramebuffer(gl.FRAMEBUFFER, window.stormTrackData.fb);

        // transparent black is no radar data
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, vertexF32.length / 2);

        // disable framebuffer, render to the map
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    var layer = {
        id: 'baseReflectivity',
        type: 'custom',

        onAdd: function (map, gl) {
            create_and_show_colorbar(colors, values);
            // create the color scale texture
            imagedata = create_WebGL_texture(colors, values);
            imagetexture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, imagetexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imagedata);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

            // compile the vertex shader
            var vertexShader = gl.createShader(gl.VERTEX_SHADER);
            gl.shaderSource(vertexShader, vertex_source);
            gl.compileShader(vertexShader);

            // compile the main fragment shader
            var fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
            gl.shaderSource(fragmentShader, fragment_source);
            gl.compileShader(fragmentShader);

            // compile the framebuffer fragment shader
            var fragmentShaderFramebuffer = gl.createShader(gl.FRAGMENT_SHADER);
            gl.shaderSource(fragmentShaderFramebuffer, fragment_framebuffer_source);
            gl.compileShader(fragmentShaderFramebuffer);

            // create the main program
            this.program = gl.createProgram();
            gl.attachShader(this.program, vertexShader);
            gl.attachShader(this.program, fragmentShader);
            gl.linkProgram(this.program);

            // create the framebuffer program
            this.programFramebuffer = gl.createProgram();
            gl.attachShader(this.programFramebuffer, vertexShader);
            gl.attachShader(this.programFramebuffer, fragmentShaderFramebuffer);
            gl.linkProgram(this.programFramebuffer);

            // retrieve the main program's uniforms
            this.matrixLocation = gl.getUniformLocation(this.program, 'u_matrix')
            this.positionLocation = gl.getAttribLocation(this.program, 'aPosition');
            this.colorLocation = gl.getAttribLocation(this.program, 'aColor');
            this.textureLocation = gl.getUniformLocation(this.program, 'u_texture');
            this.minmaxLocation = gl.getUniformLocation(this.program, 'minmax');
            this.radarLngLatLocation = gl.getUniformLocation(this.program, 'radar_lat_lng');
            this.opacityLocation = gl.getUniformLocation(this.program, 'u_opacity');
            this.radarMercLocation = gl.getUniformLocation(this.program, 'u_radarMerc');
            this.sweepModeLocation = gl.getUniformLocation(this.program, 'u_sweepMode');
            this.sweepStartLocation = gl.getUniformLocation(this.program, 'u_sweepStart');
            this.sweepProgressLocation = gl.getUniformLocation(this.program, 'u_sweepProgress');
            this.gateFilterMinLocation = gl.getUniformLocation(this.program, 'u_gateFilterMin');
            this.gateFilterMaxLocation = gl.getUniformLocation(this.program, 'u_gateFilterMax');


            // retrieve the framebuffer program's uniforms
            this.matrixLocationFramebuffer = gl.getUniformLocation(this.programFramebuffer, 'u_matrix');
            this.minmaxLocationFramebuffer = gl.getUniformLocation(this.programFramebuffer, 'minmax');
            this.radarLngLatLocationFramebuffer = gl.getUniformLocation(this.programFramebuffer, 'radar_lat_lng');
            this.radarMercLocationFramebuffer = gl.getUniformLocation(this.programFramebuffer, 'u_radarMerc');

            // var newVertexF32 = new Float32Array(vertexF32.length * 2);
            // var offset = 0;
            // for (var i = 0; i < vertexF32.length; i += 2) {
            //     var x = vertexF32[i];
            //     var y = vertexF32[i + 1];
            //     var f32x = x - x;
            //     var f32y = y - y;
            //     // if (f32x != 0) { console.log(x) }
            //     // if (f32y != 0) { console.log(y) }

            //     newVertexF32[offset] = x;
            //     newVertexF32[offset + 1] = y;
            //     newVertexF32[offset + 2] = f32x;
            //     newVertexF32[offset + 3] = f32y;
            //     offset += 4;
            // }

            // create and bind the buffer for the vertex data
            this.vertexBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
            gl.bufferData(
                gl.ARRAY_BUFFER,
                vertexF32,
                gl.STATIC_DRAW
            );

            // create and bind the buffer for the color data
            this.colorBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
            gl.bufferData(
                gl.ARRAY_BUFFER,
                colorF32,
                gl.STATIC_DRAW
            );

            // create old-data buffers for sweep reveal transition
            if (doSweepReveal && oldVertexF32 && oldColorF32) {
                this.oldVertexBuffer = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, this.oldVertexBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, oldVertexF32, gl.STATIC_DRAW);

                this.oldColorBuffer = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, this.oldColorBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, oldColorF32, gl.STATIC_DRAW);

                _sweepRevealState.active = true;
                _sweepRevealState.startAngle = sweepStartAngle;
                _sweepRevealState.startTime = sweepStartTime;
                _sweepRevealState.oldVertexCount = oldVertexCount;
            }

            // initialize the framebuffer
            createFramebuffer(gl);
        },
        render: function (gl, matrix) {
            const renderStart = performance.now();

            if (_pendingBufferUpdate) {
                vertexF32 = _pendingBufferUpdate.vertices;
                colorF32 = _pendingBufferUpdate.colors;
                gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, vertexF32, gl.DYNAMIC_DRAW);
                gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, colorF32, gl.DYNAMIC_DRAW);
                _pendingBufferUpdate = null;
            }

            // bind new-data buffers (used for framebuffer pass and as default)
            gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
            gl.enableVertexAttribArray(this.positionLocation);
            gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);

            gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
            gl.enableVertexAttribArray(this.colorLocation);
            gl.vertexAttribPointer(this.colorLocation, 1, gl.FLOAT, false, 0, 0);

            gl.bindTexture(gl.TEXTURE_2D, imagetexture);

            // framebuffer pass (color picker) — always uses new data, no sweep mask
            if ($('#colorPickerItemClass').hasClass('menu_item_selected')) {
                renderToFramebuffer.apply(this, [gl, matrix]);
            }

            // main program setup
            gl.useProgram(this.program);
            gl.uniformMatrix4fv(this.matrixLocation, false, matrix);
            gl.uniform2fv(this.radarMercLocation, [radarMercX, radarMercY]);
            gl.uniform2fv(this.minmaxLocation, [cmin, cmax]);
            gl.uniform1i(this.textureLocation, 0);
            var radarOpacity = window.stormTrackData?.radarOpacity != null ? window.stormTrackData.radarOpacity : 0.85;
            gl.uniform1f(this.opacityLocation, radarOpacity);

            var _REF_PRODUCTS = { 'REF':1, 'N0B':1, 'N1B':1, 'N2B':1, 'N3B':1, 'N0Q':1, 'N1Q':1, 'TZL':1, 'TZ0':1, 'TZ1':1, 'TZ2':1, 'TZ3':1 };
            var isRefProduct = !!_REF_PRODUCTS[product];
            var gateFilterMin, gateFilterMax;
            if (isRefProduct && window.stormTrackData?.gateFilterMin != null) {
                gateFilterMin = window.stormTrackData.gateFilterMin;
            } else {
                gateFilterMin = cmin;
            }
            if (isRefProduct && window.stormTrackData?.gateFilterMax != null) {
                gateFilterMax = window.stormTrackData.gateFilterMax;
            } else {
                gateFilterMax = cmax;
            }
            gl.uniform1f(this.gateFilterMinLocation, gateFilterMin);
            gl.uniform1f(this.gateFilterMaxLocation, gateFilterMax);

            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

            var isSweepRevealActive = _sweepRevealState.active;

            if (isSweepRevealActive && !radar_scan_animation.is_active()) {
                _sweepRevealState.active = false;
                isSweepRevealActive = false;
            }

            if (isSweepRevealActive) {
                var now = performance.now();
                var elapsed = now - _sweepRevealState.startTime;
                var SWEEP_PERIOD = radar_scan_animation.get_sweep_period_ms();

                if (elapsed >= SWEEP_PERIOD) {
                    _sweepRevealState.active = false;
                    isSweepRevealActive = false;
                    if (this.oldVertexBuffer) { gl.deleteBuffer(this.oldVertexBuffer); this.oldVertexBuffer = null; }
                    if (this.oldColorBuffer) { gl.deleteBuffer(this.oldColorBuffer); this.oldColorBuffer = null; }
                } else {
                    var currentAngle = (now % SWEEP_PERIOD) / SWEEP_PERIOD * TWO_PI;
                    var progress = currentAngle - _sweepRevealState.startAngle;
                    if (progress < 0) progress += TWO_PI;

                    // pass 1: old data — hide the region the sweep has already covered
                    gl.bindBuffer(gl.ARRAY_BUFFER, this.oldVertexBuffer);
                    gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);
                    gl.bindBuffer(gl.ARRAY_BUFFER, this.oldColorBuffer);
                    gl.vertexAttribPointer(this.colorLocation, 1, gl.FLOAT, false, 0, 0);

                    gl.uniform1f(this.sweepModeLocation, 2.0);
                    gl.uniform1f(this.sweepStartLocation, _sweepRevealState.startAngle);
                    gl.uniform1f(this.sweepProgressLocation, progress);
                    gl.drawArrays(gl.TRIANGLES, 0, _sweepRevealState.oldVertexCount);

                    // pass 2: new data — show only the swept region
                    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
                    gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);
                    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
                    gl.vertexAttribPointer(this.colorLocation, 1, gl.FLOAT, false, 0, 0);

                    gl.uniform1f(this.sweepModeLocation, 1.0);
                    gl.drawArrays(gl.TRIANGLES, 0, vertexF32.length / 2);

                    map.triggerRepaint();
                }
            }

            if (!isSweepRevealActive) {
                gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
                gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);
                gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
                gl.vertexAttribPointer(this.colorLocation, 1, gl.FLOAT, false, 0, 0);

                gl.uniform1f(this.sweepModeLocation, 0.0);
                gl.drawArrays(gl.TRIANGLES, 0, vertexF32.length / 2);
            }

            if (window.stormTrackData) {
                _renderFrameCount += 1;
                _renderAccumMs += (performance.now() - renderStart);
                if (_renderFrameCount >= 120) {
                    const perf = window.stormTrackData.perf = window.stormTrackData.perf || {};
                    perf.radarRenderFrames = _renderFrameCount;
                    perf.radarRenderAvgMs = _renderAccumMs / _renderFrameCount;
                    _renderFrameCount = 0;
                    _renderAccumMs = 0;
                }
            }
        }
    }

    map_funcs.removeMapLayer('baseReflectivity');
    map.addLayer(layer, map_funcs.get_base_layer());
    map.triggerRepaint();

    var isInFileUploadMode = window.stormTrackData.from_file_upload;

    const range = nexrad_factory?.initial_radar_obj?.max_range;
    window.stormTrackData._radarMaxRangeKm = range || 230;
    if (range != undefined) {
        const location = nexrad_factory.get_location();
        const range_circle = turf.circle([location[1], location[0]], range, { steps: 100, units: 'kilometers' });

        if (map.getSource('station_range_source')) {
            map.getSource('station_range_source').setData(range_circle);
        } else {
            map.addSource('station_range_source', {
                type: 'geojson',
                data: range_circle
            })
            map.addLayer({
                'id': 'station_range_layer',
                'type': 'line',
                'source': 'station_range_source',
                'paint': {
                    'line-color': '#999999',
                    'line-width': 0.25
                }
            });
        }
    }

    // make sure the alerts are always on top
    setLayerOrder();

    var isRadarVisChecked = $('#armrRadarVisBtnSwitchElem').is(':checked');
    var isRadiusChecked = $('#armrRadarRadiusBtnSwitchElem').is(':checked');
    if (!isRadarVisChecked) {
        map.setLayoutProperty('baseReflectivity', 'visibility', 'none');
        map.setLayoutProperty('station_range_layer', 'visibility', 'none');
    } else if (!isRadiusChecked) {
        if (map.getLayer('station_range_layer')) {
            map.setLayoutProperty('station_range_layer', 'visibility', 'none');
        }
    }

    if (isInFileUploadMode) {
        if (nexrad_factory.nexrad_level == 2) {
            const file_id = nexrad_factory.generate_unique_id();
            if (window.stormTrackData.L2_file_id_zoomed_yet != file_id) { // if we're on a new file
                window.stormTrackData.L2_file_id_zoomed_yet = file_id; // set the new id globally
                nexrad_factory.fly_to_location();
            }
        } else {
            nexrad_factory.fly_to_location();
        }
    }

    if (window?.stormTrackData?.current_RadarUpdater != undefined) {
        window.stormTrackData.current_RadarUpdater.disable();
    }
    const isLoopPlaying = !!window?.stormTrackData?.loopPlayback?.playing;
    const liveModeActive = !!window?.stormTrackData?.liveModeActive;
    // Live Mode keeps sweep as a visual effect only; do not auto-start
    // RadarUpdater here or new scans can "sweep in" unexpectedly.
    if (!isInFileUploadMode && !isLoopPlaying && !liveModeActive) {
        const current_RadarUpdater = new RadarUpdater(nexrad_factory);
        window.stormTrackData.current_RadarUpdater = current_RadarUpdater;
        current_RadarUpdater.enable();
    }

    window.stormTrackData.current_nexrad_location = nexrad_factory.get_location();
    window.stormTrackData.current_elevation_angle = nexrad_factory.elevation_angle;

    _previousScanData = {
        vertices: vertexF32,
        colors: colorF32,
        vertexCount: vertexF32.length / 2,
        radarLat: radar_lat_lng.lat,
        radarLng: radar_lat_lng.lng,
    };
}

function update_radar_buffers(new_vertices, new_colors, product, nexrad_factory) {
    if (!map.getLayer('baseReflectivity')) return false;

    _pendingBufferUpdate = { vertices: new_vertices, colors: new_colors };

    window.stormTrackData.nexrad_factory = nexrad_factory;
    window.stormTrackData.product = product;
    window.stormTrackData.product_code = nexrad_factory.product_code;
    window.stormTrackData.current_nexrad_location = nexrad_factory.get_location();
    window.stormTrackData.current_elevation_angle = nexrad_factory.elevation_angle;
    nexrad_factory.display_file_info();

    const location = nexrad_factory.get_location();
    _previousScanData = {
        vertices: new_vertices,
        colors: new_colors,
        vertexCount: new_vertices.length / 2,
        radarLat: location[0],
        radarLng: location[1],
    };

    map.triggerRepaint();
    return true;
}

plot_to_map.update_radar_buffers = update_radar_buffers;
module.exports = plot_to_map;