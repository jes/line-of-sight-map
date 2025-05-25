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

// Configuration constants
const DEGREE_STEP = 1;
const SAMPLE_POINTS = 200; // Number of points to sample along each ray
const OBSERVER_HEIGHT = 2; // Height of the observer in meters
const MAX_LINE_LENGTH_METERS = 100000; // Maximum line length (100km)

// Helper functions for map setup
function setupTerrainSource(map) {
    // Check if terrain source already exists
    if (map.getSource('terrain')) {
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
        
        map.setTerrain({ 'source': 'terrain', 'exaggeration': 1.0 });
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
    } catch (error) {
        console.error('Error adding hillshade layer:', error);
    }
}

function setupTerrainAndHillshading(map) {
    setupTerrainSource(map);
    setupHillshading(map);
}

// Initialize the map
const map = new maplibregl.Map({
    container: 'map',
    style: styles.map,
    center: [0, 0],  // Default world view (center of the map)
    zoom: 2  // Zoom level that shows most of the world
});

// Add navigation controls
map.addControl(new maplibregl.NavigationControl());

// Track if terrain is ready
let isTerrainLoaded = false;

// Add terrain source
map.on('load', () => {
    setupTerrainAndHillshading(map);

    // Wait for terrain to be loaded
    map.on('sourcedata', (e) => {
        if (e.sourceId === 'terrain' && e.isSourceLoaded && !isTerrainLoaded) {
            isTerrainLoaded = true;
        }
    });
});

// Variable to store the vantage point marker
let vantageMarker = null;
let updateTimer = null;
const LINE_OF_SIGHT_LAYER = 'line-of-sight';
const LINE_OF_SIGHT_SOURCE = 'line-of-sight-source';

// Function to get elevation at a point
async function getElevation(lngLat) {
    if (!isTerrainLoaded) {
        return 0;
    }

    try {
        const elevation = map.queryTerrainElevation(lngLat);
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

// Function to calculate destination point given start, bearing and distance
function calculateDestinationPoint(startLngLat, bearing, distance) {
    const R = 6371000; // Earth's radius in meters
    const d = distance / R;  // Angular distance
    const lat1 = startLngLat.lat * Math.PI / 180;
    const lon1 = startLngLat.lng * Math.PI / 180;
    const brng = bearing * Math.PI / 180;

    const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(d) +
        Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
    );

    const lon2 = lon1 + Math.atan2(
        Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );

    return new maplibregl.LngLat(
        (lon2 * 180 / Math.PI + 540) % 360 - 180, // Normalize longitude
        lat2 * 180 / Math.PI
    );
}

// Function to calculate maximum distance to viewport edges
function calculateViewportDistance(vantagePoint) {
    const bounds = map.getBounds();
    const ne = bounds.getNorthEast();
    const nw = bounds.getNorthWest();
    const se = bounds.getSouthEast();
    const sw = bounds.getSouthWest();

    // Calculate distances to all corners
    const distances = [ne, nw, se, sw].map(corner => {
        const cornerLngLat = new maplibregl.LngLat(corner.lng, corner.lat);
        return vantagePoint.distanceTo(cornerLngLat);
    });

    // Return the maximum distance, capped at MAX_LINE_LENGTH_METERS
    return Math.min(Math.max(...distances), MAX_LINE_LENGTH_METERS);
}

// Function to cast a ray and find terrain intersections
async function castRay(startPoint, angle, maxDistance) {
    if (!isTerrainLoaded) {
        return {
            start: startPoint,
            segments: []
        };
    }

    try {
        const startElevation = await getElevation(startPoint);
        const adjustedStartElevation = startElevation + OBSERVER_HEIGHT;

        const points = [];
        const segments = [];
        let currentSegment = null;
        let maxAngleSeen = -Infinity;

        // Sample points along the ray
        for (let i = 0; i <= SAMPLE_POINTS; i++) {
            const fraction = i / SAMPLE_POINTS;
            const distance = maxDistance * fraction;
            
            // Calculate the point coordinates using the new helper function
            const point = calculateDestinationPoint(startPoint, angle, distance);
            const elevation = await getElevation(point);

            // Calculate the angle to this point
            const pointAngle = calculateAngle(startPoint, point, adjustedStartElevation, elevation);
            
            // Determine visibility - a point is blocked if its angle is less than the maximum angle seen
            const isBlocked = pointAngle < maxAngleSeen;
            
            if (isBlocked) {
                // Point is blocked by terrain - start or continue a blocked segment
                if (!currentSegment) {
                    currentSegment = {
                        start: i > 0 ? points[i-1] : startPoint,
                        end: point,
                        isBlocked: true
                    };
                } else {
                    currentSegment.end = point;
                }
            } else {
                // Point is visible - end any current blocked segment
                if (currentSegment) {
                    segments.push(currentSegment);
                    currentSegment = null;
                }
                // Update the maximum angle seen for future point comparisons
                maxAngleSeen = Math.max(maxAngleSeen, pointAngle);
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
    } catch (error) {
        console.error('Error in castRay:', error);
        return {
            start: startPoint,
            segments: []
        };
    }
}

// Function to generate the line of sight GeoJSON
async function generateLineOfSightGeoJSON() {
    if (!vantageMarker) return null;

    const vantagePoint = vantageMarker.getLngLat();
    const viewportDistance = calculateViewportDistance(vantagePoint);
    const features = [];
    
    // Create radial lines at specified degree intervals
    for (let angle = 0; angle < 360; angle += DEGREE_STEP) {
        const rayResult = await castRay(vantagePoint, angle, viewportDistance);
        
        // Add a feature for each blocked segment
        for (const segment of rayResult.segments) {
            if (segment.isBlocked) {
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

    return {
        type: 'FeatureCollection',
        features: features
    };
}

// Function to update the line of sight layer
async function updateLineOfSight() {
    if (!isTerrainLoaded) {
        return;
    }

    try {
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
            
            if (!geojson || !geojson.features || geojson.features.length === 0) {
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
        }
    } catch (error) {
        console.error('Error updating line of sight:', error);
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
        if (messageOverlay) {
            messageOverlay.style.opacity = '0';
            setTimeout(() => {
                messageOverlay.style.display = 'none';
            }, 300);
        }

        // Add drag end handler
        vantageMarker.on('dragend', () => {
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
            // Wait a bit for terrain to be ready before updating
            setTimeout(() => {
                updateLineOfSight();
            }, 1000);
        }
    });
}); 