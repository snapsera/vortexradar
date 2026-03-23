const filter_alerts = require('../filter_alerts');

class AlertUpdater {
    constructor() {
        const return_data = require('../fetch_data').return_data;
        const plot_alerts = require('../plot_alerts');

        this.latest_date = undefined;
        this.previous_alert_ids = new Set();

        this.get_new_data_func = return_data;
        this.plot_func = plot_alerts;
    }

    enable() {
        this._check_for_new_file();
        // check for new alert data every 15 seconds
        this.interval = setInterval(() => {
            this._check_for_new_file();
        }, 15000);
    }

    disable() {
        clearInterval(this.interval);
    }

    _get_alert_id(f) {
        return f.id || f.properties?.id || null;
    }

    _check_for_new_file() {
        const { DateTime } = require('luxon');
        const formatted_now = DateTime.now().toFormat('h:mm.ss a ZZZZ');
        const combine_dictionary_data = require('../combine_dictionary_data');

        this.get_new_data_func((alerts_data) => {
            const fetched_date = DateTime.fromISO(alerts_data.updated);
            const fetched_date_ms = fetched_date.toMillis();

            this._check_for_updated_alerts(alerts_data);

            if (this.latest_date == undefined) {
                this.latest_date = fetched_date_ms;
                this.previous_alert_ids = new Set(
                    (alerts_data.features || []).map((f) => this._get_alert_id(f)).filter(Boolean)
                );
            }

            if (fetched_date_ms > this.latest_date) {
                console.log(`Successfully found new alert data at ${formatted_now}.`);
                const current_ids = new Set(
                    (alerts_data.features || []).map((f) => this._get_alert_id(f)).filter(Boolean)
                );
                const new_ids = new Set([...current_ids].filter((id) => !this.previous_alert_ids.has(id)));
                this.previous_alert_ids = current_ids;
                this.latest_date = fetched_date_ms;

                const new_alert_features = (alerts_data.features || []).filter((f) => {
                    const id = this._get_alert_id(f);
                    return id && new_ids.has(id);
                });
                const new_alert_ids = new Set(new_alert_features.map((f) => this._get_alert_id(f)));

                const focusNewAlerts = require('../../core/menu/settings_store').load().focusNewAlerts;
                let plot_data = alerts_data;
                const zonesLoaded = typeof window !== 'undefined' && typeof window.forecast_zones !== 'undefined';
                if (zonesLoaded) {
                    plot_data = combine_dictionary_data(JSON.parse(JSON.stringify(alerts_data)));
                }

                this.plot_func(plot_data, {
                    new_alert_ids: new_alert_ids,
                    new_alert_features,
                    focus_new_alerts: focusNewAlerts,
                    on_new_alerts: this._on_new_alerts.bind(this)
                });
                require('../watch_overlay').update_from_alerts_data(alerts_data);
            } else {
                console.log(`There is no new alert data as of ${formatted_now}. Last data was at ${fetched_date.toFormat('h:mm.ss a ZZZZ')}.`);
            }
        });
    }

    _on_new_alerts(features) {
        const enabled = features.filter((f) => filter_alerts.should_show_alert_feature(f));

        const focusNewAlerts = require('../../core/menu/settings_store').load().focusNewAlerts;
        if (focusNewAlerts && enabled.length > 0) {
            const focus_new_alerts = require('../focus_new_alerts');
            focus_new_alerts.focus_on_new_alerts(enabled);
        }

        const eventCounts = {};
        for (const f of enabled) {
            var event = f.properties?.event || 'Weather Alert';
            eventCounts[event] = (eventCounts[event] || 0) + 1;
        }
        for (const [event, count] of Object.entries(eventCounts)) {
            window.dispatchEvent(new CustomEvent('alertNotification', {
                detail: { event: event, type: 'new', count: count }
            }));
        }

        if (enabled.length > 0) {
            window.dispatchEvent(new CustomEvent('headerAlertBanner', {
                detail: { features: enabled }
            }));
        }
    }

    _check_for_updated_alerts(alerts_data) {
        if (!this._previous_alert_props) {
            this._previous_alert_props = new Map();
            for (const f of (alerts_data.features || [])) {
                var id = this._get_alert_id(f);
                if (id) this._previous_alert_props.set(id, f.properties || {});
            }
            return;
        }
        for (const f of (alerts_data.features || [])) {
            var id = this._get_alert_id(f);
            if (!id) continue;
            var prev = this._previous_alert_props.get(id);
            if (!prev) continue;
            var prevDesc = (prev.description || '').toLowerCase();
            var currDesc = (f.properties?.description || '').toLowerCase();
            var eventName = f.properties?.event || 'Weather Alert';
            if (prevDesc.indexOf('radar indicated') !== -1 && currDesc.indexOf('observed') !== -1) {
                window.dispatchEvent(new CustomEvent('alertNotification', {
                    detail: { event: eventName, type: 'updated', extra: 'Now OBSERVED (was radar indicated)' }
                }));
            } else if (prev.description !== f.properties?.description && prev.description && f.properties?.description) {
                window.dispatchEvent(new CustomEvent('alertNotification', {
                    detail: { event: eventName, type: 'updated' }
                }));
            }
        }
        this._previous_alert_props = new Map();
        for (const f of (alerts_data.features || [])) {
            var id = this._get_alert_id(f);
            if (id) this._previous_alert_props.set(id, f.properties || {});
        }
    }
}

module.exports = AlertUpdater;