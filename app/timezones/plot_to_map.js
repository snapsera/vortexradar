const map = require('../core/map/map');
const setLayerOrder = require('../core/map/setLayerOrder');

const TZ_BOUNDARY_SOURCE = 'timezone_boundary_source';
const TZ_BOUNDARY_LINE_LAYER = 'timezone_boundary_line';
const TZ_LABEL_LAYER = 'timezone_label_layer';

const tzBoundaryData = {
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            properties: { label: 'ET | CT' },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [-84.8, 47.2], [-87.4, 45.4], [-87.6, 43.5],
                    [-87.5, 41.8], [-87.5, 39.1], [-86.3, 37.5],
                    [-85.6, 36.0], [-85.0, 35.0], [-85.6, 33.0],
                    [-85.0, 31.0], [-87.6, 30.4]
                ]
            }
        },
        {
            type: 'Feature',
            properties: { label: 'CT | MT' },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [-104.05, 49.0], [-104.05, 46.0], [-104.05, 43.0],
                    [-104.05, 41.0], [-102.05, 40.0], [-102.05, 37.0],
                    [-103.0, 36.5], [-103.0, 32.0], [-106.5, 31.8]
                ]
            }
        },
        {
            type: 'Feature',
            properties: { label: 'MT | PT' },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [-117.0, 49.0], [-117.0, 46.0], [-117.0, 44.0],
                    [-117.0, 42.0], [-114.0, 42.0], [-114.0, 37.0],
                    [-114.7, 35.5], [-114.6, 32.7]
                ]
            }
        },
        {
            type: 'Feature',
            properties: { label: 'Eastern' },
            geometry: { type: 'Point', coordinates: [-79.5, 38.5] }
        },
        {
            type: 'Feature',
            properties: { label: 'Central' },
            geometry: { type: 'Point', coordinates: [-95.0, 38.5] }
        },
        {
            type: 'Feature',
            properties: { label: 'Mountain' },
            geometry: { type: 'Point', coordinates: [-110.0, 40.0] }
        },
        {
            type: 'Feature',
            properties: { label: 'Pacific' },
            geometry: { type: 'Point', coordinates: [-121.5, 42.0] }
        }
    ]
};

function plotToMap() {
    map.addSource(TZ_BOUNDARY_SOURCE, {
        type: 'geojson',
        data: tzBoundaryData
    });

    map.addLayer({
        id: TZ_BOUNDARY_LINE_LAYER,
        type: 'line',
        source: TZ_BOUNDARY_SOURCE,
        filter: ['==', '$type', 'LineString'],
        paint: {
            'line-color': '#e2e8f0',
            'line-width': 1.8,
            'line-dasharray': [4, 3],
            'line-opacity': 0.6
        }
    });

    map.addLayer({
        id: TZ_LABEL_LAYER,
        type: 'symbol',
        source: TZ_BOUNDARY_SOURCE,
        filter: ['==', '$type', 'Point'],
        layout: {
            'text-field': ['get', 'label'],
            'text-size': 13,
            'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
            'text-allow-overlap': false,
            'text-ignore-placement': false,
        },
        paint: {
            'text-color': '#cbd5e1',
            'text-opacity': 0.7,
            'text-halo-color': 'rgba(0,0,0,0.6)',
            'text-halo-width': 1.5,
        }
    });

    setLayerOrder();
}

const TZ_LAYERS = [TZ_BOUNDARY_LINE_LAYER, TZ_LABEL_LAYER];

module.exports = { plotToMap, TZ_LAYERS };
