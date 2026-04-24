// Line-of-sight viewshed on a MapLibre map using AWS Terrarium DEM tiles.

const BASEMAPS = {
  street: {
    tiles: ['a','b','c'].map(s => `https://${s}.tile.openstreetmap.org/{z}/{x}/{y}.png`),
    maxzoom: 19, attribution: '© OpenStreetMap contributors'
  },
  topo: {
    tiles: ['a','b','c'].map(s => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
    maxzoom: 17, attribution: '© OpenTopoMap (CC-BY-SA)'
  },
  satellite: {
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    maxzoom: 19, attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics'
  }
};
function buildStyle(kind) {
  const b = BASEMAPS[kind];
  return {
    version: 8,
    sources: { base: { type: 'raster', tiles: b.tiles, tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution } },
    layers: [{ id: 'base', type: 'raster', source: 'base' }]
  };
}
let currentBasemap = 'street';
const map = new maplibregl.Map({
  container: 'map',
  style: buildStyle(currentBasemap),
  center: [-119.5, 37.7],
  zoom: 8,
  maxZoom: 18,
  minZoom: 2,
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');

document.getElementById('basemap').addEventListener('change', (e) => {
  currentBasemap = e.target.value;
  map.setStyle(buildStyle(currentBasemap));
  map.once('idle', () => scheduleCompute());
});

// --- Geocoding (Nominatim) ---
const searchInput = document.getElementById('search');
const searchBtn = document.getElementById('searchBtn');
const searchResults = document.getElementById('searchResults');
function gotoResult(r) {
  const lat = parseFloat(r.lat), lon = parseFloat(r.lon);
  const bb = r.boundingbox && r.boundingbox.map(parseFloat);
  if (bb && bb.length === 4) {
    map.fitBounds([[bb[2], bb[0]], [bb[3], bb[1]]], { padding: 40, maxZoom: 14 });
  } else {
    map.flyTo({ center: [lon, lat], zoom: 12 });
  }
  searchResults.innerHTML = '';
}
async function doSearch(jumpFirst) {
  const q = searchInput.value.trim();
  if (!q) return;
  searchResults.innerHTML = '<div class="r">Searching…</div>';
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=6&q=${encodeURIComponent(q)}`, {
      headers: { 'Accept': 'application/json' }
    });
    const data = await res.json();
    if (!data.length) { searchResults.innerHTML = '<div class="r">No results</div>'; return; }
    if (jumpFirst) { gotoResult(data[0]); return; }
    searchResults.innerHTML = '';
    for (const r of data) {
      const d = document.createElement('div');
      d.className = 'r';
      d.textContent = r.display_name;
      d.addEventListener('click', () => gotoResult(r));
      searchResults.appendChild(d);
    }
  } catch (err) {
    searchResults.innerHTML = '<div class="r">Search failed</div>';
  }
}
searchBtn.addEventListener('click', () => doSearch(false));
searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(true); });

const overlay = document.getElementById('overlay');
const octx = overlay.getContext('2d');
const statusEl = document.getElementById('status');
const obsEl = document.getElementById('obs');
const heightEl = document.getElementById('height');
const refractionEl = document.getElementById('refraction');
const autoEl = document.getElementById('autocompute');
const computeBtn = document.getElementById('compute');
const clearBtn = document.getElementById('clear');

let observer = null; // {lng, lat}
let observerMarker = null;
let computing = false;
let pending = false;

function resizeOverlay() {
  const r = map.getContainer().getBoundingClientRect();
  overlay.width = r.width;
  overlay.height = r.height;
  overlay.style.width = r.width + 'px';
  overlay.style.height = r.height + 'px';
}
window.addEventListener('resize', () => { resizeOverlay(); scheduleCompute(); });
map.on('load', resizeOverlay);
map.on('moveend', () => { resizeOverlay(); if (autoEl.checked) scheduleCompute(); });

map.on('click', (e) => {
  observer = { lng: e.lngLat.lng, lat: e.lngLat.lat };
  obsEl.textContent = `${observer.lat.toFixed(5)}, ${observer.lng.toFixed(5)}`;
  if (observerMarker) observerMarker.remove();
  const el = document.createElement('div');
  el.style.cssText = 'width:14px;height:14px;border-radius:50%;background:#ff0;border:2px solid #000;box-shadow:0 0 6px #ff0;';
  observerMarker = new maplibregl.Marker({ element: el }).setLngLat([observer.lng, observer.lat]).addTo(map);
  computeBtn.disabled = false;
  scheduleCompute();
});

computeBtn.addEventListener('click', () => scheduleCompute());
heightEl.addEventListener('change', () => scheduleCompute());
refractionEl.addEventListener('change', () => scheduleCompute());
clearBtn.addEventListener('click', () => {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  statusEl.textContent = '';
});

function scheduleCompute() {
  if (!observer) return;
  if (computing) { pending = true; return; }
  computeViewshed().finally(() => {
    if (pending) { pending = false; scheduleCompute(); }
  });
}

// ---------- Terrarium DEM tile cache ----------
const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const tileCache = new Map();

function getTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 256;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, 256, 256).data;
      // Store decoded elevations as Float32Array for faster lookups
      const elev = new Float32Array(256 * 256);
      for (let i = 0, p = 0; i < elev.length; i++, p += 4) {
        elev[i] = (data[p] * 256 + data[p+1] + data[p+2] / 256) - 32768;
      }
      resolve(elev);
    };
    img.onerror = () => resolve(null);
    img.src = TILE_URL(z, x, y);
  });
  tileCache.set(key, p);
  return p;
}

// ---------- Web Mercator helpers ----------
const R_EARTH = 6371008.8; // mean Earth radius (m)
function lon2x(lon, z) { return ((lon + 180) / 360) * (256 << z); }
function lat2y(lat, z) {
  const s = Math.sin(lat * Math.PI / 180);
  return (0.5 - Math.log((1+s)/(1-s)) / (4*Math.PI)) * (256 << z);
}
function y2lat(y, z) {
  const n = Math.PI - 2 * Math.PI * y / (256 << z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}
function x2lon(x, z) { return x / (256 << z) * 360 - 180; }

// haversine (m)
function haversine(lat1, lon1, lat2, lon2) {
  const toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR;
  const dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*toR) * Math.cos(lat2*toR) * Math.sin(dLon/2)**2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

// ---------- Viewshed ----------
async function computeViewshed() {
  computing = true;
  try {
    const W = overlay.width, H = overlay.height;
    octx.clearRect(0, 0, W, H);

    const bounds = map.getBounds();
    const obsLng = observer.lng, obsLat = observer.lat;
    const eyeHeight = parseFloat(heightEl.value) || 0;
    const refract = refractionEl.checked;
    // Refraction: effective earth radius * 7/6, so curvature drop = d^2/(2*Reff).
    // drop coefficient k such that drop(d) = k * d^2
    const kCurv = 1 / (2 * R_EARTH * (refract ? (7/6) : 1));

    // Determine DEM zoom based on viewport size in degrees
    const latSpan = bounds.getNorth() - bounds.getSouth();
    const mapZ = map.getZoom();
    // Want DEM resolution roughly matching screen. Pick z so that viewport spans ~1024-2048 dem pixels.
    // viewport width in tiles at zoom z = (lonSpan/360) * 2^z
    const lonSpan = bounds.getEast() - bounds.getWest();
    let demZ = Math.round(Math.log2(1200 / Math.max(0.001, lonSpan) / (256/360)));
    demZ = Math.max(4, Math.min(14, demZ));
    // But also observer must be inside viewport sensibly; clamp to not explode tile count.

    statusEl.textContent = `Loading DEM tiles (z=${demZ})...`;

    // Viewport in mercator pixel coords at demZ
    const vxMin = lon2x(bounds.getWest(), demZ);
    const vxMax = lon2x(bounds.getEast(), demZ);
    const vyMin = lat2y(bounds.getNorth(), demZ); // top
    const vyMax = lat2y(bounds.getSouth(), demZ); // bottom

    // Observer pixel pos
    const obsPxX = lon2x(obsLng, demZ);
    const obsPxY = lat2y(obsLat, demZ);

    // DEM grid we'll build: wide enough to include observer + viewport + small margin
    const pad = 8;
    const gxMin = Math.floor(Math.min(vxMin, obsPxX)) - pad;
    const gxMax = Math.ceil(Math.max(vxMax, obsPxX)) + pad;
    const gyMin = Math.floor(Math.min(vyMin, obsPxY)) - pad;
    const gyMax = Math.ceil(Math.max(vyMax, obsPxY)) + pad;

    // Cap the grid size to prevent runaway memory
    const gridW = gxMax - gxMin;
    const gridH = gyMax - gyMin;
    if (gridW * gridH > 4_500_000) {
      statusEl.textContent = 'Viewport too large. Zoom in or reduce observer distance.';
      return;
    }

    // Which tiles we need
    const txMin = Math.floor(gxMin / 256);
    const txMax = Math.floor((gxMax - 1) / 256);
    const tyMin = Math.floor(gyMin / 256);
    const tyMax = Math.floor((gyMax - 1) / 256);
    const maxTiles = (tyMax - tyMin + 1) * (txMax - txMin + 1);
    if (maxTiles > 120) {
      statusEl.textContent = `Too many DEM tiles (${maxTiles}). Zoom in.`;
      return;
    }

    const tileProms = [];
    for (let ty = tyMin; ty <= tyMax; ty++) {
      for (let tx = txMin; tx <= txMax; tx++) {
        // wrap x in case crossing antimeridian
        const n = 1 << demZ;
        const wx = ((tx % n) + n) % n;
        if (ty < 0 || ty >= n) { tileProms.push(Promise.resolve({tx, ty, elev:null})); continue; }
        tileProms.push(getTile(demZ, wx, ty).then(elev => ({tx, ty, elev})));
      }
    }
    const tiles = await Promise.all(tileProms);
    const tileMap = new Map();
    for (const t of tiles) tileMap.set(`${t.tx}/${t.ty}`, t.elev);

    // Build flat elevation grid (gridH x gridW). For speed, only reproject tile into grid.
    const grid = new Float32Array(gridW * gridH);
    for (let ty = tyMin; ty <= tyMax; ty++) {
      for (let tx = txMin; tx <= txMax; tx++) {
        const elev = tileMap.get(`${tx}/${ty}`);
        if (!elev) continue;
        const tilePxX0 = tx * 256, tilePxY0 = ty * 256;
        const sx0 = Math.max(gxMin, tilePxX0);
        const sx1 = Math.min(gxMax, tilePxX0 + 256);
        const sy0 = Math.max(gyMin, tilePxY0);
        const sy1 = Math.min(gyMax, tilePxY0 + 256);
        for (let y = sy0; y < sy1; y++) {
          const srcRow = (y - tilePxY0) * 256;
          const dstRow = (y - gyMin) * gridW;
          for (let x = sx0; x < sx1; x++) {
            grid[dstRow + (x - gxMin)] = elev[srcRow + (x - tilePxX0)];
          }
        }
      }
    }

    // Meters per DEM pixel: use latitude-dependent scale at observer.
    // mercator pixel size in meters at latitude lat and zoom z:
    //   metersPerPx = Math.cos(lat*π/180) * 2*π*R / (256*2^z)
    const obsLatR = obsLat * Math.PI / 180;
    const mPerPxEquator = 2 * Math.PI * R_EARTH / (256 * (1 << demZ));

    // Observer grid pos & elev
    const ogx = obsPxX - gxMin;
    const ogy = obsPxY - gyMin;
    const obsGround = bilinear(grid, gridW, gridH, ogx, ogy);
    const obsElev = obsGround + eyeHeight;

    statusEl.textContent = 'Computing viewshed...';
    await new Promise(r => setTimeout(r, 10));

    // For each screen pixel (subsampled), reproject to DEM grid, then march along line from observer.
    const STRIDE = 3; // screen pixel stride for sampling
    const sW = Math.ceil(W / STRIDE);
    const sH = Math.ceil(H / STRIDE);
    const vis = new Uint8Array(sW * sH); // 0 unknown, 1 visible, 2 occluded, 3 out-of-data

    // For each screen pixel, map screen->lngLat->mercator->grid.
    // We'll batch convert corners and interpolate for speed.
    const mapBox = map.getContainer().getBoundingClientRect();
    // Build lookup of grid (gx, gy) per screen pixel via map.unproject
    // Using unproject per-pixel is slow; instead compute a bilinear interpolation mesh.
    const MESH = 32;
    const meshX = new Float64Array((MESH+1)*(MESH+1));
    const meshY = new Float64Array((MESH+1)*(MESH+1));
    for (let j = 0; j <= MESH; j++) {
      for (let i = 0; i <= MESH; i++) {
        const px = i / MESH * W;
        const py = j / MESH * H;
        const ll = map.unproject([px, py]);
        meshX[j*(MESH+1)+i] = lon2x(ll.lng, demZ) - gxMin;
        meshY[j*(MESH+1)+i] = lat2y(ll.lat, demZ) - gyMin;
      }
    }

    function screenToGrid(px, py) {
      const u = px / W * MESH;
      const v = py / H * MESH;
      const i = Math.min(MESH-1, Math.floor(u));
      const j = Math.min(MESH-1, Math.floor(v));
      const fu = u - i, fv = v - j;
      const a = j*(MESH+1)+i;
      const b = a + 1;
      const c = a + (MESH+1);
      const d = c + 1;
      const gx = (meshX[a]*(1-fu) + meshX[b]*fu)*(1-fv) + (meshX[c]*(1-fu) + meshX[d]*fu)*fv;
      const gy = (meshY[a]*(1-fu) + meshY[b]*fu)*(1-fv) + (meshY[c]*(1-fu) + meshY[d]*fu)*fv;
      return [gx, gy];
    }

    // Ray march per sample pixel
    let t0 = performance.now();
    for (let sj = 0; sj < sH; sj++) {
      const py = sj * STRIDE;
      for (let si = 0; si < sW; si++) {
        const px = si * STRIDE;
        const [tgx, tgy] = screenToGrid(px, py);
        if (tgx < 0 || tgy < 0 || tgx >= gridW-1 || tgy >= gridH-1) { vis[sj*sW+si] = 3; continue; }
        vis[sj*sW+si] = rayVisible(grid, gridW, gridH, ogx, ogy, obsElev, tgx, tgy, mPerPxEquator, obsLatR, kCurv) ? 1 : 2;
      }
      if (sj % 30 === 0 && performance.now() - t0 > 40) {
        // Paint progress
        paint(vis, sW, sH, STRIDE, W, H);
        await new Promise(r => setTimeout(r, 0));
        t0 = performance.now();
      }
    }
    paint(vis, sW, sH, STRIDE, W, H);
    statusEl.textContent = `Done. DEM z=${demZ}, ${sW}×${sH} samples, observer ground ${obsGround.toFixed(0)}m.`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Error: ' + err.message;
  } finally {
    computing = false;
  }
}

function bilinear(grid, gw, gh, x, y) {
  const xi = Math.max(0, Math.min(gw - 2, Math.floor(x)));
  const yi = Math.max(0, Math.min(gh - 2, Math.floor(y)));
  const fx = x - xi, fy = y - yi;
  const a = grid[yi*gw + xi];
  const b = grid[yi*gw + xi + 1];
  const c = grid[(yi+1)*gw + xi];
  const d = grid[(yi+1)*gw + xi + 1];
  return (a*(1-fx) + b*fx)*(1-fy) + (c*(1-fx) + d*fx)*fy;
}

// Ray from observer grid (ogx,ogy) to target (tgx,tgy). Returns true if target visible.
// We step in unit grid cells, compute horizontal distance (meters) applying latitude scale,
// subtract Earth-curvature drop, compare to linearly-interpolated line-of-sight elevation
// between eye and target ground elevation.
function rayVisible(grid, gw, gh, ogx, ogy, obsElev, tgx, tgy, mPerPxEq, obsLatR, kCurv) {
  const dx = tgx - ogx, dy = tgy - ogy;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return true;
  const steps = Math.max(2, Math.ceil(dist));
  const invS = 1 / steps;
  // target ground
  const tgtGround = bilinear(grid, gw, gh, tgx, tgy);
  // approximate latitude along path for mercator scale; use midpoint
  // meters per px varies with cos(lat). We'll approximate using observer lat for the whole ray
  // (acceptable for moderate viewsheds). For global rays this is not perfect.
  const mPerPx = mPerPxEq * Math.cos(obsLatR);
  // Highest elevation considered: target. Any intermediate sample whose (elev - curvatureDrop)
  // exceeds the line-of-sight elevation at that distance means target is occluded.
  // Line-of-sight elevation at fraction f: obsElev + f*(tgtGround - obsElev).
  // Curvature drop at distance d from observer: kCurv * d^2 (this lowers apparent elev of point).
  // Equivalent: add drop to LOS comparison: check if (elev) > losElev + drop ? No: drop makes
  // far points appear lower, so we SUBTRACT drop from far elevations. Occluded when
  // (elev - drop) > losElev_linear_in_drop_adjusted_space.
  // To keep it simple: adjust both endpoints and intermediate samples by the same curvature
  // formula relative to observer, then do linear LOS.
  const dTgt = dist * mPerPx;
  const tgtAdj = tgtGround - kCurv * dTgt * dTgt;
  for (let s = 1; s < steps; s++) {
    const f = s * invS;
    const gx = ogx + dx * f;
    const gy = ogy + dy * f;
    const elev = bilinear(grid, gw, gh, gx, gy);
    const d = f * dist * mPerPx;
    const adj = elev - kCurv * d * d;
    const losElev = obsElev + f * (tgtAdj - obsElev);
    if (adj > losElev) return false;
  }
  return true;
}

// Paint sampled visibility to overlay canvas.
function paint(vis, sW, sH, stride, W, H) {
  const img = octx.createImageData(W, H);
  const data = img.data;
  for (let y = 0; y < H; y++) {
    const sj = Math.min(sH - 1, Math.floor(y / stride));
    for (let x = 0; x < W; x++) {
      const si = Math.min(sW - 1, Math.floor(x / stride));
      const v = vis[sj * sW + si];
      const p = (y * W + x) * 4;
      if (v === 2) {
        // occluded: semi-transparent dark grey so basemap stays readable
        data[p] = 20; data[p+1] = 20; data[p+2] = 30; data[p+3] = 150;
      } else if (v === 1) {
        // visible: unshaded
        data[p+3] = 0;
      } else {
        data[p+3] = 0;
      }
    }
  }
  octx.putImageData(img, 0, 0);
}
