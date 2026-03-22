const ut = require('../../core/utils');

const NEXRADLevel2File = require('../libnexrad/level2/level2_parser');
const Level2Factory = require('../libnexrad/level2/level2_factory');

const NEXRADLevel3File = require('../libnexrad/level3/level3_parser');
const Level3Factory = require('../libnexrad/level3/level3_factory');

/**
 * Function that fetches a file and returns it as a Buffer.
 * 
 * @param {String} url The path to the file. It can be a local file, or a file stored on a remote server.
 * @param {*} callback A callback function that has a single paramater, which is the buffer of the file.
 */
function file_to_buffer(url, callback, signal = null) {
    // good catch! thanks CGray1234!
    if (url.includes('tgftp.nws.noaa.gov')) url = ut.phpProxy + url;

    var fetchOpts = { cache: 'no-cache' };
    if (signal) fetchOpts.signal = signal;

    fetch(url, fetchOpts)
    .then(response => response.arrayBuffer())
    .then(buffer => {
        var fileBuffer = Buffer.from(buffer);
        callback(fileBuffer);
    })
    .catch((error) => {
        if (error?.name === 'AbortError') return;
        console.error('Error fetching radar file:', error);
    });
}

/**
 * Parses a URL and returns a filename.
 * 
 * @param {String} url The url to parse.
 * @returns {String} The radar file's filename.
 */
function _url_to_filename(url) {
    const url_array = new URL(url).pathname.split('/');
    return url_array[url_array.length - 1];
}

/**
 * Function to get the latest Level 2 file for a station.
 * 
 * @param {String} station - The four letter ICAO of the station. e.g. "KLWX" / "KMHX"
 * @param {Function} callback - The function to run after the retrieval. Use a single variable
 * in this function, this will be a string with the latest file's URL.
 */
function get_latest_level_2_url(station, callback) {
    var curTime = new Date();
    var year = curTime.getUTCFullYear();
    var month = curTime.getUTCMonth() + 1;
    if (month.toString().length == 1) month = "0" + month.toString();
    var day = curTime.getUTCDate();
    if (day.toString().length == 1) day = "0" + day.toString();
    var stationToGet = station.toUpperCase().replace(/ /g, '')
    var fullURL = "https://noaa-nexrad-level2.s3.amazonaws.com/?list-type=2&delimiter=%2F&prefix=" + year + "%2F" + month + "%2F" + day + "%2F" + stationToGet + "%2F"
    //console.log(fullURL)
    var baseURL = 'https://noaa-nexrad-level2.s3.amazonaws.com';
    //https://noaa-nexrad-level2.s3.amazonaws.com/2022/08/09/KATX/KATX20220809_004942_V06
    fullURL = ut.preventFileCaching(fullURL);
    $.get(fullURL, function (data) {
        var dataToWorkWith = JSON.stringify(ut.xmlToJson(data)).replace(/#/g, 'HASH')
        dataToWorkWith = JSON.parse(dataToWorkWith)
        //console.log(dataToWorkWith)
        var filenameKey = dataToWorkWith.ListBucketResult.Contents
        var latestFileName = filenameKey[filenameKey.length - 1].Key.HASHtext.slice(16);
        if (latestFileName.includes('MDM')) {
            latestFileName = filenameKey[filenameKey.length - 2].Key.HASHtext.slice(16);
        }

        var finishedURL = `${baseURL}/${year}/${month}/${day}/${station}/${latestFileName}`;
        callback(finishedURL);
    })
}

/**
 * Function to get the latest Level 3 file for a station.
 * 
 * @param {String} station - The four letter ICAO of the station. e.g. "KLWX" / "KMHX"
 * @param {String} product - Three letter abbreviation of the Level 3 product being retrieved. e.g. "NST", "N0B", "N0G"
 * @param {Number} index - A number that represents the time of the file to load. e.g. 0 for the latest file, 5 for 5 files back, etc.
 * @param {Function} callback - The function to run after the retrieval. Use two variables
 * in this function, which will be a string with the latest file's URL, and a date object for the radar file.
 * @param {Date} date - A value used internally within the function. Do not pass a value for this parameter.
 */
const level3_url_cache = {};
const LEVEL3_URL_CACHE_TTL_MS = 10000;
const level3_frames_cache = {};
const LEVEL3_FRAMES_CACHE_TTL_MS = 10000;
function get_latest_level_3_url(station, product, index, callback, date, signal = null, timesGoneBack = 0) {
    if (signal?.aborted) return;
    if (date == undefined && timesGoneBack === 0) {
        const cache_key = `${station}_${product}_${index}`;
        const cached = level3_url_cache[cache_key];
        if (cached && (Date.now() - cached.cached_at) < LEVEL3_URL_CACHE_TTL_MS) {
            callback(cached.url, cached.date);
            return;
        }
    }

    if (
        product != 'NTV' && product != 'NMD' && product != 'NST' &&
        product != '134il' && product.slice(0, 3) != 'p94' && product.slice(0, 3) != 'p99'
    ) {
        /* we need to slice(1) here (remove the first letter) because the level 3 source we
        * are using only accepts a three character ICAO, e.g. "MHX" / "LWX" */
        var corrected_station = station.slice(1);
        //document.getElementById('spinnerParent').style.display = 'block';
        var curTime;
        if (date == undefined) {
            curTime = new Date();
        } else {
            curTime = date;
        }
        var year = curTime.getUTCFullYear();
        var month = curTime.getUTCMonth() + 1;
        if (month.toString().length == 1) month = "0" + month.toString();
        var day = curTime.getUTCDate();
        if (day.toString().length == 1) day = "0" + day.toString();
        var stationToGet = corrected_station.toUpperCase().replace(/ /g, '')
        var urlBase = "https://unidata-nexrad-level3.s3.amazonaws.com/";
        var filenamePrefix = `${corrected_station}_${product}_${year}_${month}_${day}`;
        // var urlPrefInfo = '?list-type=2&delimiter=/%2F&prefix=';
        var urlPrefInfo = '?prefix=';
        var fullURL = `${urlBase}${urlPrefInfo}${filenamePrefix}`

        fetch(fullURL, signal ? { cache: 'no-cache', signal } : { cache: 'no-cache' }).then(response => response.text())
        .then(function(data) {
            if (signal?.aborted) return;
        //$.get(ut.phpProxy + fullURL, function (data) {
            try {
                var dataToWorkWith = JSON.stringify(ut.xmlToJson(data)).replace(/#/g, 'HASH')
                dataToWorkWith = JSON.parse(dataToWorkWith)
                //console.log(dataToWorkWith)
                var contentsBase = dataToWorkWith.ListBucketResult.Contents;
                var filenameKey;
                var dateKey;
                if (Array.isArray(contentsBase)) {
                    filenameKey = contentsBase[contentsBase.length - (index + 1)].Key.HASHtext;
                    dateKey = contentsBase[contentsBase.length - (index + 1)].LastModified.HASHtext;
                } else {
                    filenameKey = contentsBase.Key.HASHtext;
                    dateKey = contentsBase.LastModified.HASHtext;
                }

                var finishedURL = `${urlBase}${filenameKey}`;
                if (date == undefined && timesGoneBack === 0) {
                    const cache_key = `${station}_${product}_${index}`;
                    level3_url_cache[cache_key] = {
                        url: finishedURL,
                        date: new Date(dateKey),
                        cached_at: Date.now()
                    };
                }
                callback(finishedURL, new Date(dateKey));
            } catch(e) {
                // we don't want to go back days for storm tracking - most of the time an empty directory
                // of storm track files means there are no storm tracks avaliable at the time (e.g. clear skies / no storms)
                if ((product != 'NTV' && product != 'NMD' && product != 'NST') && timesGoneBack < 15) {
                    // error checking - if nothing exists for this date, fetch the directory listing for the previous day
                    var d = curTime;
                    d.setDate(d.getDate() - 1);
                    get_latest_level_3_url(station, product, index, callback, d, signal, timesGoneBack + 1);
                } else {
                    callback(null);
                }
            }
        })
        .catch((error) => {
            if (error?.name === 'AbortError') return;
            console.error('Error getting latest level 3 URL:', error);
            callback(null);
        })
    } else {
        if (product == 'NST') { product = '58sti' }
        if (product == 'NTV') { product = '61tvs' }
        if (product == 'NMD') { product = '141md' }
        var fileUrl = `https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar/DS.${product}/SI.${station.toLowerCase()}/sn.last#`;
        fileUrl = ut.preventFileCaching(fileUrl);

        var tgftpFetchOpts = { cache: 'no-cache' };
        if (signal) tgftpFetchOpts.signal = signal;

        fetch(
            ut.phpProxy + `https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar/DS.${product}/SI.${station.toLowerCase()}/sn.last#`,
            tgftpFetchOpts
        )
        .then(response => {
            if (signal?.aborted) return;
            const file_modified_date = response.headers.get('Last-Modified');

            callback(fileUrl, new Date(file_modified_date));
        })
        .catch((error) => {
            if (error?.name === 'AbortError') return;
            console.error('Error getting latest special level 3 URL:', error);
            callback(null);
        })
    }

    /*
    * Below is all unused code to retrieve the latest file from a different data source.
    */
    // var curTime = new Date();
    // var year = curTime.getUTCFullYear();
    // var month = curTime.getUTCMonth() + 1;
    // if (month.toString().length == 1) month = "0" + month.toString();
    // var day = curTime.getUTCDate();
    // if (day.toString().length == 1) day = "0" + day.toString();
    // var yyyymmdd = `${year}${month}${day}`
    // var l3FileURL = `https://unidata3.ssec.wisc.edu/native/radar/level3/nexrad/${product}/${station}/${yyyymmdd}/`;
    // console.log(l3FileURL);
    // $.get(ut.phpProxy + l3FileURL, function(data) {
    //     var div = document.createElement('div')
    //     div.innerHTML = data;
    //     var jsonWithFileList = JSON.parse(ut.html2json(div));
    //     var fileListLength = jsonWithFileList.children[2].children.length;
    //     var filenameKey = jsonWithFileList.children[2].children[fileListLength - 2].attributes[0][1];

    //     var finishedURL = `${l3FileURL}${filenameKey}`;
    //     callback(finishedURL);
    // })
}

function _is_special_level_3_product(product) {
    return (
        product == 'NTV' || product == 'NMD' || product == 'NST' ||
        product == '134il' || product.slice(0, 3) == 'p94' || product.slice(0, 3) == 'p99'
    );
}

function _format_ymd(date_obj) {
    var year = date_obj.getUTCFullYear();
    var month = date_obj.getUTCMonth() + 1;
    if (month.toString().length == 1) month = `0${month}`;
    var day = date_obj.getUTCDate();
    if (day.toString().length == 1) day = `0${day}`;
    return { year, month, day };
}

function _extract_listbucket_contents(xml_text) {
    var dataToWorkWith = JSON.stringify(ut.xmlToJson(xml_text)).replace(/#/g, 'HASH');
    dataToWorkWith = JSON.parse(dataToWorkWith);
    var contentsBase = dataToWorkWith.ListBucketResult.Contents;
    if (Array.isArray(contentsBase)) {
        return contentsBase;
    }
    if (contentsBase != undefined) {
        return [contentsBase];
    }
    return [];
}

function _build_level_3_frames(contents, urlBase, count) {
    if (!contents || contents.length == 0) return [];
    const sanitized_count = Math.max(1, parseInt(count) || 1);
    const start_idx = Math.max(contents.length - sanitized_count, 0);
    const selected_contents = contents.slice(start_idx);
    return selected_contents.map((entry) => {
        const key = entry?.Key?.HASHtext;
        const modified = entry?.LastModified?.HASHtext;
        if (!key) return null;
        return {
            url: `${urlBase}${key}`,
            date: modified ? new Date(modified) : null
        };
    }).filter(Boolean);
}

/**
 * Function to get the latest Level 3 file urls for a station/product time-series.
 *
 * @param {String} station - The four letter ICAO of the station. e.g. "KLWX" / "KMHX"
 * @param {String} product - Three letter abbreviation of the Level 3 product being retrieved.
 * @param {Number} count - Number of files to return.
 * @param {Function} callback - Callback that receives an array of objects: [{ url, date }].
 * @param {Date} date - A value used internally within the function. Do not pass a value for this parameter.
 */
function _fetch_day_frames(station, product, curTime, signal) {
    var corrected_station = station.slice(1);
    const { year, month, day } = _format_ymd(curTime);
    var stationToGet = corrected_station.toUpperCase().replace(/ /g, '');
    var urlBase = 'https://unidata-nexrad-level3.s3.amazonaws.com/';
    var filenamePrefix = `${stationToGet}_${product}_${year}_${month}_${day}`;
    var fullURL = `${urlBase}?prefix=${filenamePrefix}`;

    return fetch(fullURL, signal ? { cache: 'no-cache', signal } : { cache: 'no-cache' })
        .then(response => response.text())
        .then((data) => {
            if (signal?.aborted) return [];
            const contents = _extract_listbucket_contents(data);
            return _build_level_3_frames(contents, urlBase, contents.length);
        })
        .catch((error) => {
            if (error?.name === 'AbortError') return [];
            return [];
        });
}

function _accumulate_level_3_frames(station, product, needed, accumulated, curTime, daysBack, signal, callback) {
    if (signal?.aborted) return;
    if (daysBack > 15) {
        callback(accumulated);
        return;
    }

    _fetch_day_frames(station, product, curTime, signal).then((day_frames) => {
        if (signal?.aborted) return;
        var combined = day_frames.concat(accumulated);
        if (combined.length >= needed || daysBack >= 15) {
            var result = combined.slice(Math.max(combined.length - needed, 0));
            callback(result);
        } else {
            var prevDay = new Date(curTime);
            prevDay.setDate(prevDay.getDate() - 1);
            _accumulate_level_3_frames(station, product, needed, combined, prevDay, daysBack + 1, signal, callback);
        }
    });
}

function get_latest_level_3_frames(station, product, count, callback, date, signal = null, timesGoneBack = 0) {
    if (signal?.aborted) return;
    const sanitized_count = Math.max(1, parseInt(count) || 1);

    if (date == undefined && timesGoneBack === 0) {
        const cache_key = `${station}_${product}_${sanitized_count}`;
        const cached = level3_frames_cache[cache_key];
        if (cached && (Date.now() - cached.cached_at) < LEVEL3_FRAMES_CACHE_TTL_MS) {
            callback(cached.frames);
            return;
        }
    }

    if (_is_special_level_3_product(product)) {
        get_latest_level_3_url(station, product, 0, (url, fetched_date) => {
            if (!url) {
                callback([]);
                return;
            }
            callback([{ url, date: fetched_date || null }]);
        }, date, signal, timesGoneBack);
        return;
    }

    var startTime = date == undefined ? new Date() : date;

    _accumulate_level_3_frames(station, product, sanitized_count, [], startTime, 0, signal, (frames) => {
        if (signal?.aborted) return;

        if (date == undefined && timesGoneBack === 0 && frames.length > 0) {
            const cache_key = `${station}_${product}_${sanitized_count}`;
            level3_frames_cache[cache_key] = {
                frames,
                cached_at: Date.now()
            };
        }

        callback(frames);
    });
}

/**
 * Function to return a L3Factory instance from a station and a product.
 * 
 * @param {String} station - See documentation for "get_latest_level_3_url" function.
 * @param {String} product - See documentation for "get_latest_level_3_url" function.
 * @param {Function} callback - A callback function. Passes a single variable, which is an instance of a L3Factory class.
 */
function return_level_3_factory_from_info(station, product, callback, signal = null) {
    get_latest_level_3_url(station, product, 0, (url) => {
        if (!url || signal?.aborted) return;
        return_level_3_factory_from_url(url, (L3Factory) => {
            callback(L3Factory);
        }, signal)
    }, undefined, signal)
}
/**
 * Function to return a L3Factory instance from a URL.
 * 
 * @param {String} url - See documentation for "file_to_buffer" function.
 * @param {Function} callback - A callback function. Passes a single variable, which is an instance of a L3Factory class.
 */
function return_level_3_factory_from_url(url, callback, signal = null) {
    if (!url) return;
    file_to_buffer(url, (buffer) => {
        if (signal?.aborted) return;
        const file = new NEXRADLevel3File(buffer);
        const L3Factory = new Level3Factory(file);
        callback(L3Factory);
    }, signal)
}
/**
 * Function to return a L3Factory instance from an ArrayBuffer.
 * 
 * @param {ArrayBuffer} arraybuffer - An ArrayBuffer which contains the data of the radar file.
 * @param {Function} callback - A callback function. Passes a single variable, which is an instance of a L3Factory class.
 */
function return_level_3_factory_from_buffer(arraybuffer, callback) {
    const file = new NEXRADLevel3File(arraybuffer);
    const L3Factory = new Level3Factory(file);
    callback(L3Factory);
}

/**
 * Function to quickly plot and display info about a Level 3 file.
 * 
 * @param {String} station - See documentation for "get_latest_level_3_url" function.
 * @param {String} product - See documentation for "get_latest_level_3_url" function.
 * @param {Function} callback - A callback function. Passes a single variable, which is an instance of a L3Factory class.
 */
function quick_level_3_plot(station, product, callback = null) {
    if (callback == null) { callback = function() {} }
    if (!window.stormTrackData) window.stormTrackData = {};

    if (window.stormTrackData.current_radar_load_controller) {
        window.stormTrackData.current_radar_load_controller.abort();
    }

    const load_controller = new AbortController();
    window.stormTrackData.current_radar_load_controller = load_controller;

    return_level_3_factory_from_info(station, product, (L3Factory) => {
        if (load_controller.signal.aborted) return;
        if (window.stormTrackData.current_radar_load_controller !== load_controller) return;

        if (window?.stormTrackData?.current_RadarUpdater != undefined) {
            window.stormTrackData.current_RadarUpdater.disable();
        }

        console.log('Main file:', L3Factory);
        // L3Factory.display_file_info();
        L3Factory.plot();
        window.dispatchEvent(new CustomEvent('radarBaseFactoryLoaded', {
            detail: {
                station: L3Factory.station,
                product: L3Factory.product_abbv,
                factory: L3Factory
            }
        }));

        callback(L3Factory);
    }, load_controller.signal)
}

/**
 * Function to quickly plot storm relative velocity.
 * 
 * @param {String} station - Station ICAO code
 * @param {Function} callback - Optional callback function
 */
function quick_storm_relative_velocity_plot(station, product, callback = null) {
    if (callback == null) { callback = function () { } }
    create_super_res_storm_relative_velocity(station, product, (combinedFactory) => {
        if (window?.stormTrackData?.current_RadarUpdater !== undefined) {
            window.stormTrackData.current_RadarUpdater.disable();
        }

        console.log('Main file:', combinedFactory);
        combinedFactory.plot();
        window.dispatchEvent(new CustomEvent('radarBaseFactoryLoaded', {
            detail: {
                station: combinedFactory.station,
                product: combinedFactory.product_abbv,
                factory: combinedFactory
            }
        }));
        callback(combinedFactory);
    });
}


/**
 * Plot a Level 3 file from a url.
 * 
 * @param {String} url - See documentation for "file_to_buffer" function.
 * @param {Function} callback - A callback function. Passes a single variable, which is an instance of a L3Factory class.
 */
function level_3_plot_from_url(url, callback = null) {
    if (callback == null) { callback = function() {} }
    return_level_3_factory_from_url(url, (L3Factory) => {
        if (window?.stormTrackData?.current_RadarUpdater != undefined) {
            window.stormTrackData.current_RadarUpdater.disable();
        }

        L3Factory.plot();
        callback(L3Factory);
    })
}


/**
 * Function to return a L2Factory instance from an ArrayBuffer.
 * 
 * @param {ArrayBuffer} arraybuffer - An ArrayBuffer which contains the data of the radar file.
 * @param {Function} callback - A callback function. Passes a single variable, which is an instance of a L2Factory class.
 */
function return_level_2_factory_from_buffer(arraybuffer, callback, filename) {
    new NEXRADLevel2File(arraybuffer, (file) => {
        const L2Factory = new Level2Factory(file);
        callback(L2Factory);
    }, filename);
}

/**
 * Calculate the storm component contribution along a radial direction
 * 
 * @param {Number} stormSpeed - Storm speed in appropriate units
 * @param {Number} stormDirection - Storm direction in degrees
 * @param {Number} azimuth - Radial azimuth angle in degrees
 * @returns {Number} The component of the storm vector along the radial
 */
function calculateStormComponent(stormSpeed, stormDirection, azimuth) {
    // Convert angles to radians
    const stormDirRad = stormDirection * Math.PI / 180;
    const azimuthRad = azimuth * Math.PI / 180;

    // Calculate the component
    return stormSpeed * Math.cos(stormDirRad - azimuthRad);
}



/**
 * Processes storm relative velocity data by combining base velocity data with storm vector information.
 * This function creates a factory that adds storm motion vector correction to base velocity measurements.
 * 
 * @param {Object} baseVelocityFactory - The factory object for base velocity data processing
 * @param {Object} stormVectorFactory - The factory object containing storm vector information from N0S product
 * @returns {Object} A modified velocity factory with storm-relative velocity calculation capability
 * 
 * @description
 * The function extracts storm motion vector information (speed and direction) from the product description
 * in the stormVectorFactory. It then creates a combined factory that inherits from baseVelocityFactory,
 * but overrides the get_data method to apply storm motion correction to the velocity measurements.
 * 
 * Storm speed is converted from knots to meters per second.
 * 
 * The storm component is used to modify each valid velocity measurement, ignoring missing or range-folded values.
 */
function process_storm_relative_velocity(baseVelocityFactory, stormVectorFactory) {
    const combinedFactory = Object.assign(Object.create(Object.getPrototypeOf(baseVelocityFactory)), baseVelocityFactory);
    combinedFactory.storm_relative_velocity = true;
    // Extract storm motion vector information from N0S product
    // Get storm speed and dir from the product description block
    const product_desc = stormVectorFactory.initial_radar_obj.prod_desc;

    
    const stormSpeed = (product_desc.dep8 || 0) / 10 * 0.514444; // Convert to m/s
    const stormDirection = (product_desc.dep9 || 0) / 10;
    // Override the get_data method to apply the storm vector to the velocity data
    const originalGetData = combinedFactory.get_data;
    combinedFactory.get_data = function () {
        const velocityData = originalGetData.call(this);
        const azimuthAngles = this.get_azimuth_angles();

        // Apply the storm vector to each gate in each radial
        return velocityData.map((radial, i) => {
            const azimuth = azimuthAngles[i];
            return radial.map(velocity => {
                if (velocity === null || 
                    velocity === this.initial_radar_obj.map_data.MISSING ||
                    velocity === this.initial_radar_obj.map_data.RANGE_FOLD) {
                    return velocity;
                }

                // Calculate the storm component in the radial direction
                const stormComponent = calculateStormComponent(stormSpeed, stormDirection, azimuth);

                // Modify the storm component from the measured velocity
                return velocity + stormComponent;
            });
        });
    };

    // Update product information to indicate this is storm relative velocity

    return combinedFactory;
}


/**
 * Function to create storm relative velocity by combining storm vector and base velocity data.
 * 
 * @param {String} station - The station ICAO code
 * @param {Function} callback - A callback function that receives the combined L3Factory instance
 */
function create_super_res_storm_relative_velocity(station, product, callback) {
    // Get the storm vector data from N0S product
    return_level_3_factory_from_info(station, 'N0S', (stormVectorFactory) => {
        return_level_3_factory_from_info(station, product, (baseVelocityFactory) => {
            const combinedFactory = process_storm_relative_velocity(baseVelocityFactory, stormVectorFactory);
            combinedFactory.isStormRelative = true;
            callback(combinedFactory);
        });
    });
}

module.exports = {
    file_to_buffer,
    get_latest_level_2_url,
    get_latest_level_3_url,
    get_latest_level_3_frames,

    return_level_3_factory_from_info,
    return_level_3_factory_from_url,
    return_level_3_factory_from_buffer,
    quick_level_3_plot,
    level_3_plot_from_url,

    return_level_2_factory_from_buffer,

    create_super_res_storm_relative_velocity,
    quick_storm_relative_velocity_plot,
    process_storm_relative_velocity
};
