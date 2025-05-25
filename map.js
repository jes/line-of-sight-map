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

// Handle style switching
document.getElementById('style-switch').addEventListener('change', (event) => {
    const selectedStyle = event.target.value;
    map.setStyle(styles[selectedStyle]);
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