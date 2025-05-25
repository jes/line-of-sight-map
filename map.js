// Map style URLs
const styles = {
    map: {
        version: 8,
        sources: {
            osm: {
                type: 'raster',
                tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                tileSize: 256,
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            }
        },
        layers: [{
            id: 'osm',
            type: 'raster',
            source: 'osm',
            minzoom: 0,
            maxzoom: 19
        }]
    },
    satellite: {
        version: 8,
        sources: {
            satellite: {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256,
                attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
            }
        },
        layers: [{
            id: 'satellite',
            type: 'raster',
            source: 'satellite',
            minzoom: 0,
            maxzoom: 19
        }]
    }
};

// Initialize the map
const map = new maplibregl.Map({
    container: 'map',
    style: styles.map,
    center: [0, 0],  // Starting position [lng, lat]
    zoom: 2  // Starting zoom level
});

// Add navigation controls
map.addControl(new maplibregl.NavigationControl());

// Variable to store the vantage point marker
let vantageMarker = null;
let updateTimer = null;
const LINE_OF_SIGHT_LAYER = 'line-of-sight';
const LINE_OF_SIGHT_SOURCE = 'line-of-sight-source';
const LINE_LENGTH_PX = 200;
const DEGREE_STEP = 1;

// Function to generate the line of sight GeoJSON
function generateLineOfSightGeoJSON() {
    if (!vantageMarker) return null;

    const vantagePoint = vantageMarker.getLngLat();
    const features = [];
    
    // Create radial lines at 1-degree intervals
    for (let angle = 0; angle < 360; angle += DEGREE_STEP) {
        // Calculate end point in screen coordinates
        const radians = (angle * Math.PI) / 180;
        const endX = LINE_LENGTH_PX * Math.cos(radians);
        const endY = LINE_LENGTH_PX * Math.sin(radians);
        
        // Convert vantage point to screen coordinates
        const vantageScreen = map.project([vantagePoint.lng, vantagePoint.lat]);
        
        // Calculate end point relative to vantage point and convert back to geographical coordinates
        const endPoint = map.unproject([
            vantageScreen.x + endX,
            vantageScreen.y + endY
        ]);
        
        // Create a line feature from vantage point to end point
        features.push({
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: [
                    [vantagePoint.lng, vantagePoint.lat],
                    [endPoint.lng, endPoint.lat]
                ]
            }
        });
    }

    return {
        type: 'FeatureCollection',
        features: features
    };
}

// Function to update the line of sight layer
function updateLineOfSight() {
    // Remove existing layer and source if they exist
    if (map.getLayer(LINE_OF_SIGHT_LAYER)) {
        map.removeLayer(LINE_OF_SIGHT_LAYER);
    }
    if (map.getSource(LINE_OF_SIGHT_SOURCE)) {
        map.removeSource(LINE_OF_SIGHT_SOURCE);
    }

    // Only add new layer if we have a vantage point
    if (vantageMarker) {
        const geojson = generateLineOfSightGeoJSON();
        
        map.addSource(LINE_OF_SIGHT_SOURCE, {
            type: 'geojson',
            data: geojson
        });

        map.addLayer({
            id: LINE_OF_SIGHT_LAYER,
            type: 'line',
            source: LINE_OF_SIGHT_SOURCE,
            paint: {
                'line-color': '#000000',
                'line-opacity': 0.2,
                'line-width': 1
            }
        });
    }
}

// Debounced update function for view changes
function debouncedUpdate() {
    if (updateTimer) {
        clearTimeout(updateTimer);
    }
    updateTimer = setTimeout(updateLineOfSight, 500);
}

// Handle map clicks to set vantage point
map.on('click', (e) => {
    const coordinates = e.lngLat;
    
    // If marker already exists, move it
    if (vantageMarker) {
        vantageMarker.setLngLat(coordinates);
    } else {
        // Create new marker
        vantageMarker = new maplibregl.Marker({
            color: '#FF0000',
            draggable: true
        })
        .setLngLat(coordinates)
        .addTo(map);

        // Hide the message overlay after first click
        const messageOverlay = document.getElementById('message-overlay');
        messageOverlay.style.opacity = '0';
        setTimeout(() => {
            messageOverlay.style.display = 'none';
        }, 300);
    }
    
    // Update lines after vantage point changes
    debouncedUpdate();
});

// Update lines when the view changes
map.on('moveend', debouncedUpdate);
map.on('zoomend', debouncedUpdate);
map.on('rotateend', debouncedUpdate);

// Update lines when marker is dragged
if (vantageMarker) {
    vantageMarker.on('dragend', debouncedUpdate);
}

// Handle style switching
document.getElementById('style-switch').addEventListener('change', (event) => {
    const selectedStyle = event.target.value;
    map.setStyle(styles[selectedStyle]);
    
    // Re-add marker and lines after style change
    if (vantageMarker) {
        const coordinates = vantageMarker.getLngLat();
        map.once('style.load', () => {
            vantageMarker.addTo(map);
            updateLineOfSight();
        });
    }
});

// This will be useful for adding custom layers later
map.on('style.load', () => {
    // Here you can add custom layers after the base style is loaded
    // Example:
    // map.addLayer({
    //     id: 'custom-layer',
    //     type: 'circle',
    //     source: {
    //         type: 'geojson',
    //         data: { ... }
    //     },
    //     paint: { ... }
    // });
}); 