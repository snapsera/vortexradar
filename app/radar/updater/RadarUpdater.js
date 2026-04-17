const product_abbv_dict = {
    'N0Q': 'p94r0',
    'N1Q': 'p94r1',
    'N2Q': 'p94r2',
    'N3Q': 'p94r3',

    'N0U': 'p99v0',
    'N1U': 'p99v1',
    'N2U': 'p99v2',
    'N3U': 'p99v3',

    // 'DVL': '134il'
}

class RadarUpdater {
    constructor(nexrad_factory) {
        const loaders_nexrad = require('../libnexrad/loaders_nexrad');

        this.nexrad_factory = nexrad_factory;
        this.latest_date = undefined;
        this._pending_plot = false;

        var get_latest_url_func;
        var plot_func;
        if (this.nexrad_factory.nexrad_level == 2) {
            get_latest_url_func = loaders_nexrad.get_latest_level_2_url;
        } else if (this.nexrad_factory.nexrad_level == 3) {
            get_latest_url_func = loaders_nexrad.get_latest_level_3_url;

            if (this.nexrad_factory.storm_relative_velocity) {
                plot_func = (url, done) => {
                    const product = this._product_from_abbv(this.nexrad_factory.product_abbv);
                    loaders_nexrad.create_super_res_storm_relative_velocity(this.nexrad_factory.station, product,
                        (combinedFactory) => {
                            combinedFactory.plot();
                            if (done) done();
                        });
                };
            } else {
                plot_func = (url, done) => {
                    loaders_nexrad.level_3_plot_from_url(url, () => {
                        if (done) done();
                    });
                };
            }
        }
        this.get_latest_url_func = get_latest_url_func;
        this.plot_func = plot_func;
    }

    enable() {
        this._check_for_new_file();
        // check for a new radar scan every 15 seconds
        this.interval = setInterval(() => {
            this._check_for_new_file();
        }, 15000);
    }

    disable() {
        clearInterval(this.interval);
    }

    _check_for_new_file() {
        if (this._pending_plot) return;

        const { DateTime } = require('luxon');
        const formatted_now = DateTime.now().toFormat('h:mm.ss a ZZZZ');

        // this is so we can update the time elapsed counter in the top right
        this.nexrad_factory.display_file_info();
        const product = this._product_from_abbv(this.nexrad_factory.product_abbv);
        this.get_latest_url_func(this.nexrad_factory.station, product, 0, (url, fetched_date) => {
            this._process_update_check(url, fetched_date, formatted_now);
        })
    }
    _product_from_abbv(product) {
        if (product_abbv_dict.hasOwnProperty(product)) {
            return product_abbv_dict[product];
        }
        return product;
    }
    _process_update_check(url, fetched_date, formatted_now) {
        if (this.latest_date == undefined) {
            this.latest_date = fetched_date;
        }

        if (fetched_date.getTime() > this.latest_date.getTime()) {
            console.log(`Successfully found new radar scan at ${formatted_now}.`);
            const previous_date = this.latest_date;
            this.latest_date = fetched_date;
            this._pending_plot = true;

            const radar_scan_animation = require('../station_markers/radar_scan_animation');
            if (previous_date && fetched_date) {
                const scan_gap_ms = fetched_date.getTime() - previous_date.getTime();
                radar_scan_animation.set_sweep_period_ms(scan_gap_ms);
            }
            if (radar_scan_animation.is_active()) {
                // Preview mode wants instant frame swaps; keep sweep as a visual overlay only.
                if (!window?.stormTrackData?.radarPreviewMode) {
                    window.stormTrackData._sweepRevealNextPlot = true;
                } else {
                    window.stormTrackData._sweepRevealNextPlot = false;
                }
            }

            this.plot_func(url, () => {
                this._pending_plot = false;
                window.dispatchEvent(new CustomEvent('radarScanUpdated'));

                if (!radar_scan_animation.is_active()) {
                    const map = require('../../core/map/map');
                    map.triggerRepaint();
                }
            });
        } else {
            console.log(`There is no new radar scan as of ${formatted_now}.`);
        }
    }
}

module.exports = RadarUpdater;