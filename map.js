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

// Helper functions for map setup
function setupTerrainSource(map) {
    console.log('Adding terrain source...');
    
    // Check if terrain source already exists
    if (map.getSource('terrain')) {
        console.log('Terrain source already exists, removing...');
        map.removeSource('terrain');
    }

    try {
        map.addSource('terrain', {
            'type': 'raster-dem',
            'tiles': [
                'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
            ],
            'tileSize': 256,
            'maxzoom': 15,
            'encoding': 'terrarium'
        });
        console.log('Successfully added terrain source');
        
        console.log('Setting up terrain exaggeration...');
        map.setTerrain({ 'source': 'terrain', 'exaggeration': 1.0 });
        console.log('Terrain setup complete');
    } catch (error) {
        console.error('Error setting up terrain:', error);
    }
}

function setupHillshading(map) {
    try {
        // Remove existing hillshade layer if it exists
        if (map.getLayer('hillshading')) {
            map.removeLayer('hillshading');
        }

        map.addLayer({
            'id': 'hillshading',
            'source': 'terrain',
            'type': 'hillshade',
            'paint': {
                'hillshade-exaggeration': 1.0,
                'hillshade-illumination-direction': 315,
                'hillshade-illumination-anchor': 'viewport',
                'hillshade-shadow-color': 'rgba(0, 0, 0, 0.5)',
                'hillshade-highlight-color': 'rgba(255, 255, 255, 0.5)',
                'hillshade-accent-color': 'rgba(0, 0, 0, 0.5)'
            }
        });
        
        console.log('Successfully added hillshade layer');
    } catch (error) {
        console.error('Error adding hillshade layer:', error);
    }
}

function setupTerrainAndHillshading(map) {
    setupTerrainSource(map);
    setupHillshading(map);
}

console.log('Initializing map...');

// Initialize the map
const map = new maplibregl.Map({
    container: 'map',
    style: styles.map,
    center: [-106.8677, 39.1911],  // Aspen, Colorado
    zoom: 12
});

// Add navigation controls
map.addControl(new maplibregl.NavigationControl());

// Track if terrain is ready
let isTerrainLoaded = false;

// Add terrain source
map.on('load', () => {
    console.log('Map style loaded');
    setupTerrainAndHillshading(map);

    // Wait for terrain to be loaded
    map.on('sourcedata', (e) => {
        if (e.sourceId === 'terrain' && e.isSourceLoaded && !isTerrainLoaded) {
            console.log('Terrain data loaded!');
            isTerrainLoaded = true;
        }
    });
});

// Variable to store the vantage point marker
let vantageMarker = null;
let updateTimer = null;
const LINE_OF_SIGHT_LAYER = 'line-of-sight';
const LINE_OF_SIGHT_SOURCE = 'line-of-sight-source';
const LINE_LENGTH_METERS = 1000; // 1km sight distance
const DEGREE_STEP = 1;
const SAMPLE_POINTS = 50; // Number of points to sample along each ray

// Function to decode elevation from terrarium encoding
function getElevationFromTerrainRGB(r, g, b) {
    return (r * 256 + g + b / 256) - 32768;
}

// Function to get elevation at a point
async function getElevation(lngLat) {
    if (!isTerrainLoaded) {
        console.warn('Terrain data not yet loaded');
        return 0;
    }

    try {
        const elevation = map.queryTerrainElevation(lngLat);
        console.log(`Elevation at ${lngLat.lng.toFixed(4)}, ${lngLat.lat.toFixed(4)}: ${elevation}`);
        return elevation || 0;
    } catch (e) {
        console.error('Error getting elevation:', e);
        return 0;
    }
}

// Function to calculate angle between two points
function calculateAngle(start, end, startElevation, endElevation) {
    // Calculate the horizontal distance in meters
    const startLatLng = new maplibregl.LngLat(start.lng, start.lat);
    const endLatLng = new maplibregl.LngLat(end.lng, end.lat);
    const distance = startLatLng.distanceTo(endLatLng);
    
    // Calculate the elevation difference
    const heightDiff = endElevation - startElevation;
    
    // Calculate the angle in radians
    return Math.atan2(heightDiff, distance);
}

// Function to cast a ray and find terrain intersections
async function castRay(startPoint, angle, maxDistance) {
    if (!isTerrainLoaded) {
        return {
            start: startPoint,
            segments: []
        };
    }

    const startElevation = await getElevation(startPoint);
    const OBSERVER_HEIGHT = 2; // 2 meters above ground
    const adjustedStartElevation = startElevation + OBSERVER_HEIGHT;

    // Convert angle to radians for calculation
    const angleRad = (angle * Math.PI) / 180;
    
    const points = [];
    const segments = [];
    let currentSegment = null;
    let maxAngleSeen = -Infinity;

    // Sample points along the ray
    for (let i = 0; i <= SAMPLE_POINTS; i++) {
        const fraction = i / SAMPLE_POINTS;
        const distance = maxDistance * fraction;
        
        // Calculate the point coordinates
        const bearing = angle;
        const point = new maplibregl.LngLat(startPoint.lng, startPoint.lat).toBearing(bearing, distance);
        const elevation = await getElevation(point);

        // Calculate the angle to this point
        const pointAngle = calculateAngle(startPoint, point, adjustedStartElevation, elevation);
        
        // Determine visibility
        const isBlocked = pointAngle > maxAngleSeen;
        
        if (isBlocked) {
            // Point is blocked - start or continue a blocked segment
            if (!currentSegment) {
                currentSegment = {
                    start: i > 0 ? points[i-1] : startPoint,
                    end: point,
                    isBlocked: true
                };
            } else {
                currentSegment.end = point;
            }
            maxAngleSeen = Math.max(maxAngleSeen, pointAngle);
        } else {
            // Point is visible - end any current blocked segment
            if (currentSegment) {
                segments.push(currentSegment);
                currentSegment = null;
            }
        }

        points.push(point);
    }

    // Add final segment if we ended with a blocked segment
    if (currentSegment) {
        segments.push(currentSegment);
    }

    return {
        start: startPoint,
        segments: segments
    };
}

// Function to generate the line of sight GeoJSON
async function generateLineOfSightGeoJSON() {
    if (!vantageMarker) return null;

    console.log('Generating line of sight GeoJSON');
    const vantagePoint = vantageMarker.getLngLat();
    const features = [];
    
    // Create radial lines at 1-degree intervals
    for (let angle = 0; angle < 360; angle += DEGREE_STEP) {
        const rayResult = await castRay(vantagePoint, angle, LINE_LENGTH_METERS);
        
        // Add a feature for each blocked segment
        for (const segment of rayResult.segments) {
            if (segment.isBlocked) {
                console.log(`Adding blocked segment at angle ${angle}`);
                features.push({
                    type: 'Feature',
                    geometry: {
                        type: 'LineString',
                        coordinates: [
                            [segment.start.lng, segment.start.lat],
                            [segment.end.lng, segment.end.lat]
                        ]
                    }
                });
            }
        }
    }

    console.log(`Generated ${features.length} blocked segments`);
    return {
        type: 'FeatureCollection',
        features: features
    };
}

// Function to update the line of sight layer
async function updateLineOfSight() {
    if (!isTerrainLoaded) {
        console.warn('Waiting for terrain to load...');
        return;
    }

    console.log('Updating line of sight layer...');

    // Remove existing layer and source if they exist
    if (map.getLayer(LINE_OF_SIGHT_LAYER)) {
        map.removeLayer(LINE_OF_SIGHT_LAYER);
    }
    if (map.getSource(LINE_OF_SIGHT_SOURCE)) {
        map.removeSource(LINE_OF_SIGHT_SOURCE);
    }

    // Only add new layer if we have a vantage point
    if (vantageMarker) {
        const geojson = await generateLineOfSightGeoJSON();
        console.log('Generated GeoJSON:', geojson);
        
        if (!geojson || !geojson.features || geojson.features.length === 0) {
            console.warn('No features generated');
            return;
        }

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
                'line-opacity': 0.5,
                'line-width': 2
            }
        });
        
        console.log('Line of sight layer added');
    }
}

// Debounced update function for view changes
function debouncedUpdate() {
    if (updateTimer) {
        clearTimeout(updateTimer);
    }
    updateTimer = setTimeout(async () => {
        if (isTerrainLoaded) {
            await updateLineOfSight();
        }
    }, 500);
}

// Handle map clicks to set vantage point
map.on('click', (e) => {
    console.log('Map clicked, setting vantage point...');
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

        // Add drag end handler
        vantageMarker.on('dragend', () => {
            console.log('Marker dragged, updating line of sight...');
            debouncedUpdate();
        });
    }
    
    // Update lines after vantage point changes
    debouncedUpdate();
});

// Update lines when the view changes
map.on('moveend', debouncedUpdate);
map.on('zoomend', debouncedUpdate);
map.on('rotateend', debouncedUpdate);

// Handle style switching
document.getElementById('style-switch').addEventListener('change', (event) => {
    const selectedStyle = event.target.value;
    map.setStyle(styles[selectedStyle]);
    
    // Re-add terrain, marker and lines after style change
    map.once('style.load', () => {
        setupTerrainAndHillshading(map);

        // Re-add marker if it exists
        if (vantageMarker) {
            vantageMarker.addTo(map);
            updateLineOfSight();
        }
    });
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