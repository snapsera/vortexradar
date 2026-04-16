const get_nexrad_location = require('../nexrad_locations').get_nexrad_location;
const progress_bar = require('../../../core/misc/progress_bar');

const work = require('webworkify');
const decompress_worker = require('./decompress_worker');

class NEXRADLevel2File {
    constructor (fileBuffer, callback, filename) {
        this.filename = filename;
        this.nexradLevel = 2;

        progress_bar.show_progress_bar();

        const w = work(decompress_worker);
        w.addEventListener('message', (ev) => {
            if (ev.data.message == 'finish') {
                progress_bar.hide_progress_bar();

                var result = ev.data.data;
                this.volume_header = result.volume_header;
                this._records = result.records;

                this.radial_records = this._records.filter(r => r['header']['type'] == 31);
                this.msg_type = '31';
                if (this.radial_records.length == 0) {
                    this.radial_records = this._records.filter(r => r['header']['type'] == 1);
                    this.msg_type = '1';
                }
                if (this.radial_records.length == 0) {
                    console.error('No MSG31 records found, cannot read file');
                }
                var elev_nums = this.radial_records.map(m => m['msg_header']['elevation_number']);
                this.scan_msgs = Array.from({ length: Math.max(...elev_nums) }, (_, i) => {
                    return elev_nums.reduce((acc, val, idx) => {
                        if (val === i + 1) acc.push(idx);
                        return acc;
                    }, []);
                });
                this.nscans = this.scan_msgs.length;

                var msg_5 = this._records.filter(r => r['header']['type'] == 5);
                if (msg_5.length) {
                    this.vcp = msg_5[0];
                } else {
                    this.vcp = null;
                    console.error('No MSG5 detected. Setting to meaningless data.');
                }

                callback(this);
                w.terminate();
            } else if (ev.data.message == 'progress') {
                const percent = ev.data.data;
                progress_bar.set_progress_bar_width(percent);
                progress_bar.set_progress_bar_text(`Loading... ${percent}%`);
            }
        });

        w.postMessage(fileBuffer);
    }
    location(station = null) {
        /*
        Find the location of the radar.

        Returns all zeros if location is not available.

        Returns
        -------
        latitude : float
            Latitude of the radar in degrees.
        longitude : float
            Longitude of the radar in degrees.
        height : int
            Height of radar and feedhorn in meters above mean sea level.
        */

        var lat, lon, alt;
        if (this.msg_type == '1' && station != null) {
            [lat, lon, alt] = get_nexrad_location(station);
        } else if (
            this.volume_header.hasOwnProperty('icao') &&
            this.msg_type == '1'
        ) {
            [lat, lon, alt] = get_nexrad_location(this.volume_header['icao']);
        } else if (this.radial_records[0].hasOwnProperty('VOL')) {
            var dic = this.radial_records[0]['VOL'];
            var height = dic['height'] + dic['feedhorn_height'];
            [lat, lon, alt] = [dic['lat'], dic['lon'], height];
        } else {
            return [0.0, 0.0, 0.0];
        }
        return [lat, lon, alt];
    }
    scan_info(scans = null) {
        /*
        Return a list of dictionaries with scan information.

        Parameters
        ----------
        scans : list ot None
            Scans (0 based) for which ray (radial) azimuth angles will be
            retrieved.  None (the default) will return the angles for all
            scans in the volume.

        Returns
        -------
        scan_info : list, optional
            A list of the scan performed with a dictionary with keys
            'moments', 'ngates', 'nrays', 'first_gate' and 'gate_spacing'
            for each scan.  The 'moments', 'ngates', 'first_gate', and
            'gate_spacing' keys are lists of the NEXRAD moments and gate
            information for that moment collected during the specific scan.
            The 'nrays' key provides the number of radials collected in the
            given scan.
        */

        let info = [];

        if (scans === null) {
            scans = Array.from({ length: this.nscans }, (_, i) => i);
        }
        for (var scan of scans) {
            var nrays = this.get_nrays(scan);
            if (nrays < 2) {
                this.nscans -= 1;
                continue;
            }
            var msg31_number = this.scan_msgs[scan][0];
            var msg = this.radial_records[msg31_number];
            var nexrad_moments = ['REF', 'VEL', 'SW', 'ZDR', 'PHI', 'RHO', 'CFP'];
            var moments = nexrad_moments.filter(f => f in msg);
            var ngates = moments.map(f => msg[f]['ngates']);
            var gate_spacing = moments.map(f => msg[f]['gate_spacing']);
            var first_gate = moments.map(f => msg[f]['first_gate']);
            info.push({
                'nrays': nrays,
                'ngates': ngates,
                'gate_spacing': gate_spacing,
                'first_gate': first_gate,
                'moments': moments
            });
        }
        return info;
    }
    get_vcp_pattern() {
        /*
        Return the numerical volume coverage pattern (VCP) or None if unknown.
        */
        if (this.vcp == null) {
            return null;
        } else {
            return this.vcp['msg5_header']['pattern_number'];
        }
    }
    get_nrays(scan) {
        /*
        Return the number of rays in a given scan.

        Parameters
        ----------
        scan : int
            Scan of interest (0 based).

        Returns
        -------
        nrays : int
            Number of rays (radials) in the scan.
        */

        return this.scan_msgs[scan].length;
    }
    get_ngates(scan_num, moment) {
        // obj = this.scan_info([scan])[0]
        // moment_index = obj['moments'].index(moment)
        // return obj['ngates'][moment_index]
        var dic = this.radial_records[this.scan_msgs[scan_num][0]][moment];
        var ngates = dic['ngates'];
        return ngates;
    }
    get_range(scan_num, moment) {
        /*
        Return an array of gate ranges for a given scan and moment.

        Parameters
        ----------
        scan_num : int
            Scan number (0 based).
        moment : 'REF', 'VEL', 'SW', 'ZDR', 'PHI', 'RHO', or 'CFP'
            Moment of interest.

        Returns
        -------
        range : ndarray
            Range in meters from the antenna to the center of gate (bin).
        */

        var dic = this.radial_records[this.scan_msgs[scan_num][0]][moment];
        var ngates = dic['ngates'];
        var first_gate = dic['first_gate'];
        var gate_spacing = dic['gate_spacing'];
        return Array.from({ length: ngates }, (_, i) => i * gate_spacing + first_gate);
    }
    // helper functions for looping over scans
    _msg_nums(scans) {
        /* Find the all message number for a list of scans. */
        return scans.flatMap(i => this.scan_msgs[i]);
    }
    _radial_array(scans, key) {
        /* Return an array of radial header elements for all rays in scans. */
        var msg_nums = this._msg_nums(scans);
        var temp = msg_nums.map(i => this.radial_records[i]['msg_header'][key]);
        return temp;
    }
    _radial_sub_array(scans, key) {
        /* Return an array of RAD or msg_header elements for all rays in scans. */
        var msg_nums = this._msg_nums(scans);
        var tmp;
        if (this.msg_type == '31') {
            tmp = msg_nums.map(i => this.radial_records[i]['RAD'][key]);
        } else {
            tmp = msg_nums.map(i => this.radial_records[i]['msg_header'][key]);
        }
        return tmp;
    }
    get_times(scans = null) {
        /*
        Retrieve the times at which the rays were collected.

        Parameters
        ----------
        scans : list or None
            Scans (0-based) to retrieve ray (radial) collection times from.
            None (the default) will return the times for all scans in the
            volume.

        Returns
        -------
        time_start : Datetime
            Initial time.
        time : ndarray
            Offset in seconds from the initial time at which the rays
            in the requested scans were collected.
        */

        if (scans == null) {
            scans = Array.from({ length: this.nscans }, (_, i) => i);
        }
        var days = this._radial_array(scans, 'collect_date');
        var secs = this._radial_array(scans, 'collect_ms').map(ms => ms / 1000.0);
        var offset = new Date((parseInt(days[0]) - 1) * 86400000 + parseInt(secs[0]) * 1000);
        var time_start = new Date(offset.getTime());
        var time = secs.map((sec, index) => {
            return sec - parseInt(secs[0]) + (parseInt(days[index]) - parseInt(days[0])) * 86400;
        });
        return [time_start, time];
    }
    get_azimuth_angles(scans = null) {
        /*
        Retrieve the azimuth angles of all rays in the requested scans.

        Parameters
        ----------
        scans : list ot None
            Scans (0 based) for which ray (radial) azimuth angles will be
            retrieved. None (the default) will return the angles for all
            scans in the volume.

        Returns
        -------
        angles : ndarray
            Azimuth angles in degress for all rays in the requested scans.
        */

        if (scans == null) {
            scans = Array.from({ length: this.nscans }, (_, i) => i);
        }
        var scale;
        if (this.msg_type == '1') {
            scale = 180 / (4096 * 8.0);
        } else {
            scale = 1.0;
        }
        return this._radial_array(scans, 'azimuth_angle').map(i => i * scale);
    }
    get_elevation_angles(scans = null) {
        /*
        Retrieve the elevation angles of all rays in the requested scans.

        Parameters
        ----------
        scans : list or None
            Scans (0 based) for which ray (radial) azimuth angles will be
            retrieved. None (the default) will return the angles for
            all scans in the volume.

        Returns
        -------
        angles : ndarray
            Elevation angles in degress for all rays in the requested scans.
        */

        if (scans == null) {
            scans = Array.from({ length: this.nscans }, (_, i) => i);
        }
        var scale;
        if (this.msg_type == '1') {
            scale = 180 / (4096 * 8.0);
        } else {
            scale = 1.0;
        }
        return this._radial_array(scans, 'elevation_angle').map(i => i * scale);
    }
    get_target_angles(scans = null) {
        /*
        Retrieve the target elevation angle of the requested scans.

        Parameters
        ----------
        scans : list or None
            Scans (0 based) for which the target elevation angles will be
            retrieved. None (the default) will return the angles for all
            scans in the volume.

        Returns
        -------
        angles : ndarray
            Target elevation angles in degress for the requested scans.
        */

        if (scans == null) {
            scans = Array.from({ length: this.nscans }, (_, i) => i);
        }
        if (this.msg_type == '31') {
            var cut_parameters;
            if (this.vcp != null) {
                cut_parameters = this.vcp['cut_parameters'];
            }
            var scale = 360.0 / 65536.0;
            return scans.map(i => cut_parameters[i]['elevation_angle'] * scale);
        } else {
            var scale = 180 / (4096 * 8.0);
            var msgs = scans.map(i => this.radial_records[this.scan_msgs[i][0]]);
            var msgs_elevation = msgs.map(m => m.msg_header.elevation_angle * scale);
            var rounded_elevation = msgs_elevation.map(e => Math.round(e * 10) / 10);
            return rounded_elevation;
        }
    }
    get_nyquist_vel(scans = null) {
        /*
        Retrieve the Nyquist velocities of the requested scans.

        Parameters
        ----------
        scans : list or None
            Scans (0 based) for which the Nyquist velocities will be
            retrieved. None (the default) will return the velocities for all
            scans in the volume.

        Returns
        -------
        velocities : ndarray
            Nyquist velocities (in m/s) for the requested scans.
        */

        if (scans == null) {
            scans = Array.from({ length: this.nscans }, (_, i) => i);
        }
        return this._radial_sub_array(scans, 'nyquist_vel').map(i => i * 0.01);
    }
    get_unambigous_range(scans = null) {
        /*
        Retrieve the unambiguous range of the requested scans.

        Parameters
        ----------
        scans : list or None
            Scans (0 based) for which the unambiguous range will be retrieved.
            None (the default) will return the range for all scans in the
            volume.

        Returns
        -------
        unambiguous_range : ndarray
            Unambiguous range (in meters) for the requested scans.
        */

        if (scans == null) {
            scans = Array.from({ length: this.nscans }, (_, i) => i);
        }
        // unambiguous range is stored in tenths of km, x100 for meters
        return this._radial_sub_array(scans, 'unambig_range').map(i => i * 100.0);
    }
    get_data(moment, scans = null, raw_data = false) {
        /*
        Retrieve moment data for a given set of scans.

        Masked points indicate that the data was not collected, below
        threshold or is range folded.

        Parameters
        ----------
        moment : 'REF', 'VEL', 'SW', 'ZDR', 'PHI', 'RHO', or 'CFP'
            Moment for which to to retrieve data.
        raw_data : bool
            True to return the raw data, False to perform masking as well as
            applying the appropiate scale and offset to the data.  When
            raw_data is True values of 1 in the data likely indicate that
            the gate was not present in the sweep, in some cases in will
            indicate range folded data.
        scans : list or None.
            Scans to retrieve data from (0 based). None (the default) will
            get the data for all scans in the volume.

        Returns
        -------
        data : ndarray
        */

        function _masked_less_equal(arr, val) {
            var masked_data = [];
            for (var i = 0; i < arr.length; i++) {
                var row = [];
                for (var j = 0; j < arr[i].length; j++) {
                    if (arr[i][j] <= val) {
                        row.push(null);
                    } else {
                        row.push(arr[i][j]);
                    }
                }
                masked_data.push(row);
            }
            return masked_data;
        }

        if (scans == null) {
            scans = Array.from({ length: this.nscans }, (_, i) => i);
        }

        var max_ngates = this.get_ngates(scans[0], moment);

        // determine the number of rays
        var msg_nums = this._msg_nums(scans);
        var nrays = msg_nums.length;
        // extract the data
        var set_datatype = false;
        var data = Array.from({ length: nrays }, () => Array(max_ngates).fill(1));
        for (var [i, msg_num] of msg_nums.entries()) {
            var msg = this.radial_records[msg_num];
            if (!msg.hasOwnProperty(moment)) {
                continue;
            }
            // if (!set_datatype) {
            //     data = data.astype('>' + _bits_to_code(msg, moment));
            //     set_datatype = true;
            // }
            var ngates = Math.min(msg[moment]['ngates'], max_ngates, msg[moment]['data'].length);
            data[i] = Array.from(msg[moment]['data']);
        }
        // return raw data if requested
        if (raw_data) {
            return data;
        }

        // mask, scan and offset, assume that the offset and scale
        // are the same in all scans/gates
        for (var scan of scans) {  // find a scan which contains the moment
            var msg_num = this.scan_msgs[scan][0];
            var msg = this.radial_records[msg_num];
            if (msg.hasOwnProperty(moment)) {
                var offset = new Float32Array([msg[moment]['offset']])[0];
                var scale = new Float32Array([msg[moment]['scale']])[0];
                var mask = data.map(row => row.map(val => val <= 1));
                var scaled_data = data.map(row => row.map(val => (val - offset) / scale));
                return scaled_data.map((row, i) => row.map((val, j) => {
                    var is_masked = mask[i][j];
                    return is_masked ? null : val;
                }));
            }
        }

        // moment is not present in any scan, mask all values
        return data.map(row => row.map(val => (val <= 1) ? null : val));
    }
}

module.exports = NEXRADLevel2File;