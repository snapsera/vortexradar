const map = require('../map/map');

class MapPopup {
    constructor (lngLat, html_content) {
        if (Array.isArray(lngLat)) {
            lngLat = new mapboxgl.LngLat(...lngLat);
        }
        this.lngLat = lngLat;
        this.html_content = html_content;

        this._init();
        // this.add_to_map();
    }

    _init() {
        $('.map-popup').remove();
        this.map_popup_div = $('<div>', { 'class': 'map-popup' }).html(this.html_content);
    }

    add_to_map() {
        $('body').append(this.map_popup_div);
        this.update_popup_pos();

        map.on('move', this._move);
        map.on('click', this._click);
    }

    remove() {
        this.map_popup_div.remove();

        map.off('move', this._move);
        map.off('click', this._click);
    }

    update_popup_pos() {
        const pixel_coords = map.project(this.lngLat);

        const triangle_height = 10;
        const popupWidth = this.map_popup_div.outerWidth();
        const popupHeight = this.map_popup_div.outerHeight();
        const headerHeight = $('#radarHeader').height() || 0;
        const viewportWidth = $(window).width() || 0;
        const viewportHeight = $(window).height() || 0;
        const viewportPadding = 6;
        const minTop = headerHeight + viewportPadding;
        const maxTop = Math.max(minTop, viewportHeight - popupHeight - viewportPadding);
        const minLeft = viewportPadding;
        const maxLeft = Math.max(minLeft, viewportWidth - popupWidth - viewportPadding);

        const centeredLeft = pixel_coords.x - (popupWidth / 2);
        const left = Math.min(maxLeft, Math.max(minLeft, centeredLeft));
        const topAbove = pixel_coords.y - (popupHeight - headerHeight) - triangle_height;
        const topBelow = pixel_coords.y + headerHeight + triangle_height;
        const fitsAbove = topAbove >= minTop && (topAbove + popupHeight) <= (viewportHeight - viewportPadding);
        const fitsBelow = topBelow >= minTop && (topBelow + popupHeight) <= (viewportHeight - viewportPadding);

        let shouldOpenBelow = false;
        if (fitsAbove) {
            shouldOpenBelow = false;
        } else if (fitsBelow) {
            shouldOpenBelow = true;
        } else {
            const overflowAbove = Math.max(0, minTop - topAbove) + Math.max(0, (topAbove + popupHeight) - (viewportHeight - viewportPadding));
            const overflowBelow = Math.max(0, minTop - topBelow) + Math.max(0, (topBelow + popupHeight) - (viewportHeight - viewportPadding));
            shouldOpenBelow = overflowBelow < overflowAbove;
        }

        const rawTop = shouldOpenBelow ? topBelow : topAbove;
        const top = Math.min(maxTop, Math.max(minTop, rawTop));
        const arrowLeft = Math.max(12, Math.min(popupWidth - 12, pixel_coords.x - left));

        this.map_popup_div.toggleClass('popup-below', shouldOpenBelow);
        this.map_popup_div.toggleClass('popup-above', !shouldOpenBelow);
        this.map_popup_div.css('--popup-arrow-left', `${arrowLeft}px`);
        this.map_popup_div.css({ 'left': left, 'top': top });
    }

    _move = () => { this.update_popup_pos.apply(this, []) };
    _click = () => { this.remove.apply(this, []) };

    // main() {
    //     var click_lngLat;
    //     var map_popup_div;
    //     function update_popup_pos(lngLat) {
    //         const pixel_coords = map.project(lngLat);

    //         const left = pixel_coords.x - (map_popup_div.width() / 2);
    //         map_popup_div.css({ 'left': left, 'top': pixel_coords.y });
    //     }
    //     function _popup_click(e) {
    //         $('.map-popup').remove();
    //         map_popup_div = $('<div>', { 'class': 'map-popup' });
    //         $('body').append(map_popup_div);

    //         click_lngLat = e.lngLat;
    //         update_popup_pos(click_lngLat);
    //     }
    //     function _popup_move(e) {
    //         if (click_lngLat != undefined) {
    //             update_popup_pos(click_lngLat);
    //         }
    //     }
    //     map.on('click', _popup_click);
    //     map.on('move', _popup_move);
    // }
}

module.exports = MapPopup;