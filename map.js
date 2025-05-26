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
const DEGREE_STEP = 0.5;
const SAMPLE_POINTS = 800; // Number of points to sample along each ray
let OBSERVER_HEIGHT = 1.8; // Height of the observer in meters
const MAX_LINE_LENGTH_METERS = 100000; // Maximum line length (100km)
const EARTH_RADIUS = 6371000; // Earth's radius in meters
const PROGRESSIVE_RENDERING = {
    anglesPerIteration: 45, // Process 45 angles per iteration
    totalAngles: 3000,     // Target total number of angles (increased from 1000 to 10000)
    delayBetweenIterations: 10 // 10ms delay between iterations
};

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

// URL Fragment State Management
function updateUrlFragment() {
    const center = map.getCenter();
    const zoom = map.getZoom();
    const fragment = {
        lat: center.lat.toFixed(6),
        lng: center.lng.toFixed(6),
        zoom: zoom.toFixed(2),
        style: document.getElementById('style-switch').value
    };
    
    if (vantageMarker) {
        const vantagePoint = vantageMarker.getLngLat();
        fragment.vantageLat = vantagePoint.lat.toFixed(6);
        fragment.vantageLng = vantagePoint.lng.toFixed(6);
    }
    
    const fragmentString = Object.entries(fragment)
        .map(([key, value]) => `${key}=${value}`)
        .join('&');
    
    window.location.hash = fragmentString;
}

function parseUrlFragment() {
    const fragment = window.location.hash.substring(1);
    if (!fragment) return null;
    
    const params = {};
    fragment.split('&').forEach(param => {
        const [key, value] = param.split('=');
        // Only parse as float for numeric values
        params[key] = ['lat', 'lng', 'zoom', 'vantageLat', 'vantageLng'].includes(key) 
            ? parseFloat(value) 
            : value;
    });
    
    return params;
}

// Function to create and setup a vantage marker
function createVantageMarker(coordinates) {
    // Remove existing marker if any
    if (vantageMarker) {
        vantageMarker.remove();
    }
    
    // Create new marker
    vantageMarker = new maplibregl.Marker({
        color: '#FF0000',
        draggable: true
    })
    .setLngLat(coordinates)
    .addTo(map);
    
    // Hide instructions and show delete button
    const instructions = document.getElementById('instructions');
    if (instructions) {
        instructions.style.display = 'none';
    }
    updateDeleteButtonVisibility();
    
    // Add drag end handler
    vantageMarker.on('dragend', () => {
        debouncedUpdate();
        updateUrlFragment();
    });
    
    // Update line of sight
    debouncedUpdate();
}

function restoreStateFromUrl() {
    const params = parseUrlFragment();
    if (!params) return;
    
    // Restore style first if specified
    if (params.style && styles[params.style]) {
        const styleSelect = document.getElementById('style-switch');
        styleSelect.value = params.style;
        map.setStyle(styles[params.style]);
    }
    
    // Restore viewport
    if (params.lat && params.lng && params.zoom) {
        map.setCenter([params.lng, params.lat]);
        map.setZoom(params.zoom);
    }
    
    // Restore vantage point
    if (params.vantageLat && params.vantageLng) {
        const coordinates = new maplibregl.LngLat(params.vantageLng, params.vantageLat);
        createVantageMarker(coordinates);
    }
}

// Initialize the map
const map = new maplibregl.Map({
    container: 'map',
    style: styles.map,
    center: [0, 0],  // Default world view (center of the map)
    zoom: 2,  // Zoom level that shows most of the world
    maxCanvasSize: [32768, 32768]
});

// Add navigation controls
map.addControl(new maplibregl.NavigationControl());

// Add observer height input handler
document.getElementById('observer-height').addEventListener('input', (e) => {
    const newHeight = parseFloat(e.target.value);
    if (!isNaN(newHeight)) {
        OBSERVER_HEIGHT = newHeight;
        if (vantageMarker) {
            debouncedUpdate();
        }
    }
});

// Track if terrain is ready
let isTerrainLoaded = false;

// Add terrain source and restore state
map.on('load', () => {
    setupTerrainAndHillshading(map);

    // Wait for terrain to be loaded
    map.on('sourcedata', (e) => {
        if (e.sourceId === 'terrain' && e.isSourceLoaded && !isTerrainLoaded) {
            isTerrainLoaded = true;
            // Restore state after terrain is loaded
            restoreStateFromUrl();
            
            // Force a viewport update to trigger marker position recalculation
            if (vantageMarker) {
                const center = map.getCenter();
                map.setCenter([center.lng + 0.000001, center.lat]);
                setTimeout(() => {
                    map.setCenter([center.lng, center.lat]);
                }, 50);
            }
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

// Function to calculate Earth's curvature drop at a given distance
function calculateEarthCurvatureDrop(distance) {
    // Using the formula: drop = (distance^2) / (2 * Earth's radius)
    // This is an approximation that works well for distances up to about 100km
    return (distance * distance) / (2 * EARTH_RADIUS);
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

            // Calculate Earth's curvature drop at this distance
            const curvatureDrop = calculateEarthCurvatureDrop(distance);
            
            // Adjust the elevation by subtracting the curvature drop
            const adjustedElevation = elevation - curvatureDrop;

            // Calculate the angle to this point
            const pointAngle = calculateAngle(startPoint, point, adjustedStartElevation, adjustedElevation);
            
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
async function generateLineOfSightGeoJSON(degreeStep = DEGREE_STEP) {
    if (!vantageMarker) return null;

    const vantagePoint = vantageMarker.getLngLat();
    const viewportDistance = calculateViewportDistance(vantagePoint);
    const features = [];
    
    // Create radial lines at specified degree intervals
    for (let angle = 0; angle < 360; angle += degreeStep) {
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

// Progressive rendering state
let progressiveRenderTimer = null;
let isProgressiveRendering = false;
let currentFeatures = []; // Store all features generated so far
let processedAngles = new Set(); // Track which angles have been processed

// Function to start progressive rendering
function startProgressiveRendering() {
    // Clear any existing progressive rendering
    if (progressiveRenderTimer) {
        clearTimeout(progressiveRenderTimer);
    }
    
    // Reset state
    currentFeatures = [];
    processedAngles = new Set();
    
    // Set up progressive rendering
    isProgressiveRendering = true;
    
    // Start the first iteration
    processNextBatchOfAngles();
}

// Function to process the next batch of angles
async function processNextBatchOfAngles() {
    if (!isProgressiveRendering || !isTerrainLoaded || !vantageMarker) {
        return;
    }
    
    try {
        const vantagePoint = vantageMarker.getLngLat();
        const viewportDistance = calculateViewportDistance(vantagePoint);
        
        // Generate new features for the current batch
        const newFeatures = [];
        let anglesProcessed = 0;
        
        // Process angles until we've done our batch or reached the total
        while (anglesProcessed < PROGRESSIVE_RENDERING.anglesPerIteration && 
               processedAngles.size < PROGRESSIVE_RENDERING.totalAngles) {
            
            // Generate a random angle between 0 and 360
            const angle = Math.random() * 360;
            
            // Skip if we've already processed this angle (with a small tolerance)
            const roundedAngle = Math.round(angle * 10) / 10; // Round to 1 decimal place
            if (processedAngles.has(roundedAngle)) {
                continue;
            }
            
            // Mark this angle as processed
            processedAngles.add(roundedAngle);
            anglesProcessed++;
            
            // Cast the ray and process the result
            const rayResult = await castRay(vantagePoint, angle, viewportDistance);
            
            // Add a feature for each blocked segment
            for (const segment of rayResult.segments) {
                if (segment.isBlocked) {
                    newFeatures.push({
                        type: 'Feature',
                        properties: { angle: angle },
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
        
        // Add new features to our collection
        if (newFeatures.length > 0) {
            currentFeatures = [...currentFeatures, ...newFeatures];
            
            // Update the source data
            if (map.getSource(LINE_OF_SIGHT_SOURCE)) {
                map.getSource(LINE_OF_SIGHT_SOURCE).setData({
                    type: 'FeatureCollection',
                    features: currentFeatures
                });
            } else {
                // Create the source and layer if they don't exist
                map.addSource(LINE_OF_SIGHT_SOURCE, {
                    type: 'geojson',
                    data: {
                        type: 'FeatureCollection',
                        features: currentFeatures
                    }
                });
                
                map.addLayer({
                    id: LINE_OF_SIGHT_LAYER,
                    type: 'line',
                    source: LINE_OF_SIGHT_SOURCE,
                    paint: {
                        'line-color': '#000000',
                        'line-opacity': 0.2,
                        'line-width': 2
                    }
                });
            }
        }
        
        // Schedule the next batch if we haven't reached the total
        if (processedAngles.size < PROGRESSIVE_RENDERING.totalAngles) {
            progressiveRenderTimer = setTimeout(processNextBatchOfAngles, PROGRESSIVE_RENDERING.delayBetweenIterations);
        } else {
            isProgressiveRendering = false;
        }
    } catch (error) {
        console.error('Error processing batch of angles:', error);
        isProgressiveRendering = false;
    }
}

// Function to stop progressive rendering
function stopProgressiveRendering() {
    isProgressiveRendering = false;
    if (progressiveRenderTimer) {
        clearTimeout(progressiveRenderTimer);
        progressiveRenderTimer = null;
    }
}

// Debounced update function for view changes
function debouncedUpdate() {
    if (updateTimer) {
        clearTimeout(updateTimer);
    }
    
    // Stop any ongoing progressive rendering
    stopProgressiveRendering();
    
    // Clear existing layer and source
    if (map.getLayer(LINE_OF_SIGHT_LAYER)) {
        map.removeLayer(LINE_OF_SIGHT_LAYER);
    }
    if (map.getSource(LINE_OF_SIGHT_SOURCE)) {
        map.removeSource(LINE_OF_SIGHT_SOURCE);
    }
    
    updateTimer = setTimeout(async () => {
        if (isTerrainLoaded) {
            // Start progressive rendering instead of immediate full update
            startProgressiveRendering();
        }
    }, 100);
}

// Function to update delete button visibility
function updateDeleteButtonVisibility() {
    const deleteButton = document.getElementById('delete-vantage');
    if (deleteButton) {
        deleteButton.style.display = vantageMarker ? 'block' : 'none';
    }
}

// Function to delete vantage point
function deleteVantagePoint() {
    if (vantageMarker) {
        vantageMarker.remove();
        vantageMarker = null;
        
        // Clear any existing line of sight visualization
        if (map.getLayer(LINE_OF_SIGHT_LAYER)) {
            map.removeLayer(LINE_OF_SIGHT_LAYER);
        }
        if (map.getSource(LINE_OF_SIGHT_SOURCE)) {
            map.removeSource(LINE_OF_SIGHT_SOURCE);
        }
        
        // Show instructions again and hide delete button
        const instructions = document.getElementById('instructions');
        if (instructions) {
            instructions.style.display = 'block';
        }
        updateDeleteButtonVisibility();
        
        // Update URL fragment
        updateUrlFragment();
    }
}

// Handle map clicks to set vantage point
map.on('click', (e) => {
    createVantageMarker(e.lngLat);
    updateUrlFragment();
});

// Initialize delete button visibility
updateDeleteButtonVisibility();

// Add delete button handler
document.getElementById('delete-vantage').addEventListener('click', deleteVantagePoint);

// Update lines when the view changes
map.on('moveend', () => {
    debouncedUpdate();
    updateUrlFragment();
});
map.on('zoomend', () => {
    debouncedUpdate();
    updateUrlFragment();
});
map.on('rotateend', () => {
    debouncedUpdate();
    updateUrlFragment();
});

// Handle style switching
document.getElementById('style-switch').addEventListener('change', (event) => {
    const selectedStyle = event.target.value;
    map.setStyle(styles[selectedStyle]);
    
    // Update URL fragment when style changes
    updateUrlFragment();
    
    // Re-add terrain, marker and lines after style change
    map.once('style.load', () => {
        setupTerrainAndHillshading(map);

        // Re-add marker if it exists
        if (vantageMarker) {
            vantageMarker.addTo(map);
            // Wait a bit for terrain to be ready before updating
            setTimeout(() => {
                debouncedUpdate();
            }, 100);
        }
    });
});

// Function to calculate bearing between two points
function calculateBearing(start, end) {
    const startLat = start.lat * Math.PI / 180;
    const startLng = start.lng * Math.PI / 180;
    const endLat = end.lat * Math.PI / 180;
    const endLng = end.lng * Math.PI / 180;

    const y = Math.sin(endLng - startLng) * Math.cos(endLat);
    const x = Math.cos(startLat) * Math.sin(endLat) -
              Math.sin(startLat) * Math.cos(endLat) * Math.cos(endLng - startLng);
    
    let bearing = Math.atan2(y, x) * 180 / Math.PI;
    bearing = (bearing + 360) % 360; // Normalize to 0-360
    return bearing;
}

// Function to format distance in appropriate units
function formatDistance(meters) {
    if (meters < 1000) {
        return `${Math.round(meters)}m`;
    } else {
        return `${(meters / 1000).toFixed(1)}km`;
    }
}

// Function to format angle in degrees
function formatAngle(radians) {
    return `${(radians * 180 / Math.PI).toFixed(1)}°`;
}

// Function to update hover info display
async function updateHoverInfo(e) {
    const hoverInfo = document.getElementById('hover-info');
    
    if (!vantageMarker) {
        hoverInfo.classList.remove('visible');
        return;
    }

    const vantagePoint = vantageMarker.getLngLat();
    const hoverPoint = e.lngLat;
    
    // Calculate distance
    const distance = vantagePoint.distanceTo(hoverPoint);
    
    // Calculate bearing
    const bearing = calculateBearing(vantagePoint, hoverPoint);
    
    // Calculate elevation angle with Earth's curvature
    const startElevation = await getElevation(vantagePoint);
    const endElevation = await getElevation(hoverPoint);
    const adjustedStartElevation = startElevation + OBSERVER_HEIGHT;
    
    // Calculate Earth's curvature drop at this distance
    const curvatureDrop = calculateEarthCurvatureDrop(distance);
    
    // Adjust the end elevation by subtracting the curvature drop
    const adjustedEndElevation = endElevation - curvatureDrop;
    
    // Calculate the elevation angle with adjusted elevations
    const elevationAngle = calculateAngle(vantagePoint, hoverPoint, adjustedStartElevation, adjustedEndElevation);
    
    // Update the display
    hoverInfo.innerHTML = `
        <div>Distance: ${formatDistance(distance)}</div>
        <div>Bearing: ${bearing.toFixed(1)}°</div>
        <div>Elevation angle: ${formatAngle(elevationAngle)}</div>
    `;
    hoverInfo.classList.add('visible');
}

// Add hover event handlers
map.on('mousemove', updateHoverInfo);
map.on('mouseout', () => {
    const hoverInfo = document.getElementById('hover-info');
    hoverInfo.classList.remove('visible');
}); 