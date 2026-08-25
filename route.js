const MAPBOX_TOKEN = '__MAPBOX_PUBLIC_TOKEN__';
const ALPR_TILEJSON = 'https://tiles.dontgetflocked.com/cameras-us-hourly.json';
const ALPR_SOURCE_ID = 'deflock-alpr';
const ALPR_LAYER_ID = 'deflock-alpr-loader';
const ALPR_SOURCE_LAYER = 'cameras';
const ALPR_DISPLAY_SOURCE_ID = 'dflckt-alpr-areas';
const ALPR_DISPLAY_FILL_ID = 'dflckt-alpr-areas-fill';
const ALPR_DISPLAY_STROKE_ID = 'dflckt-alpr-areas-stroke';
const ROUTE_MATCH_METERS = 75;
const DISPLAY_RADIUS_METERS = 110;

const routeForm = document.querySelector('[data-route-form]');
const routeMessage = document.querySelector('[data-route-message]');
const routeResults = document.querySelector('[data-route-results]');
const routeButton = document.querySelector('[data-route-submit]');

let map;
let markers = [];
let activeRoutes = [];

function setMessage(text, type = '') {
  routeMessage.textContent = text;
  routeMessage.className = `route-message ${type}`.trim();
}

function miles(meters) {
  return (meters / 1609.344).toFixed(meters < 16093 ? 1 : 0);
}

function minutes(seconds) {
  return Math.max(1, Math.round(seconds / 60));
}

async function apiError(response, fallback) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body.message || body.error || '';
  } catch (_) {
    try { detail = await response.text(); } catch (_) {}
  }
  return new Error(`${fallback} (${response.status})${detail ? `: ${detail}` : ''}`);
}

async function geocode(query) {
  const url = new URL('https://api.mapbox.com/search/geocode/v6/forward');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '1');
  url.searchParams.set('country', 'US');
  url.searchParams.set('access_token', MAPBOX_TOKEN);

  const response = await fetch(url);
  if (!response.ok) throw await apiError(response, 'Geocoding request failed');
  const data = await response.json();
  if (!data.features || !data.features.length) throw new Error(`Could not find “${query}”`);

  const feature = data.features[0];
  return {
    coordinates: feature.geometry.coordinates,
    label: feature.properties?.full_address || feature.properties?.name || query
  };
}

async function getRoutes(origin, destination) {
  const coords = `${origin.coordinates[0]},${origin.coordinates[1]};${destination.coordinates[0]},${destination.coordinates[1]}`;
  const url = new URL(`https://api.mapbox.com/directions/v5/mapbox/driving/${coords}`);
  url.searchParams.set('alternatives', 'true');
  url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('overview', 'full');
  url.searchParams.set('steps', 'false');
  url.searchParams.set('access_token', MAPBOX_TOKEN);

  const response = await fetch(url);
  if (!response.ok) throw await apiError(response, 'Routing request failed');
  const data = await response.json();
  if (!data.routes || !data.routes.length) throw new Error('No driving route was found between those locations');
  return data.routes;
}

function ensureMap(center) {
  if (map) return;
  mapboxgl.accessToken = MAPBOX_TOKEN;
  map = new mapboxgl.Map({
    container: 'route-map',
    style: 'mapbox://styles/mapbox/dark-v11',
    center,
    zoom: 10,
    attributionControl: true
  });
  map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
}

function ensureAlprSource() {
  if (!map || map.getSource(ALPR_SOURCE_ID)) return;
  map.addSource(ALPR_SOURCE_ID, { type: 'vector', url: ALPR_TILEJSON });
  map.addLayer({
    id: ALPR_LAYER_ID,
    type: 'circle',
    source: ALPR_SOURCE_ID,
    'source-layer': ALPR_SOURCE_LAYER,
    paint: {
      'circle-radius': 1,
      'circle-opacity': 0,
      'circle-stroke-opacity': 0
    }
  });
}

function ensureApproximateAlprDisplay() {
  if (!map) return;
  if (!map.getSource(ALPR_DISPLAY_SOURCE_ID)) {
    map.addSource(ALPR_DISPLAY_SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
  }
  if (!map.getLayer(ALPR_DISPLAY_FILL_ID)) {
    map.addLayer({
      id: ALPR_DISPLAY_FILL_ID,
      type: 'fill',
      source: ALPR_DISPLAY_SOURCE_ID,
      paint: {
        'fill-color': '#f0c24b',
        'fill-opacity': 0.18
      }
    });
  }
  if (!map.getLayer(ALPR_DISPLAY_STROKE_ID)) {
    map.addLayer({
      id: ALPR_DISPLAY_STROKE_ID,
      type: 'line',
      source: ALPR_DISPLAY_SOURCE_ID,
      paint: {
        'line-color': '#f0c24b',
        'line-opacity': 0.72,
        'line-width': 1.5
      }
    });
  }
}

function clearMapRoutes() {
  if (!map) return;
  ['route-fastest', 'route-alt-1', 'route-alt-2'].forEach(id => {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  });
  if (map.getSource(ALPR_DISPLAY_SOURCE_ID)) {
    map.getSource(ALPR_DISPLAY_SOURCE_ID).setData({ type: 'FeatureCollection', features: [] });
  }
  markers.forEach(marker => marker.remove());
  markers = [];
}

function addRouteLayer(id, geometry, color, width, opacity) {
  map.addSource(id, { type: 'geojson', data: { type: 'Feature', geometry } });
  map.addLayer({
    id,
    type: 'line',
    source: id,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': color, 'line-width': width, 'line-opacity': opacity }
  });
}

function drawRoutes(routes, origin, destination) {
  ensureMap(origin.coordinates);
  activeRoutes = routes.slice(0, 3);

  const render = () => {
    clearMapRoutes();
    ensureAlprSource();
    ensureApproximateAlprDisplay();
    const colors = ['#37a7ff', '#667481', '#414b56'];
    const ids = ['route-fastest', 'route-alt-1', 'route-alt-2'];

    activeRoutes.forEach((route, index) => {
      addRouteLayer(ids[index], route.geometry, colors[index], index === 0 ? 6 : 4, index === 0 ? 0.95 : 0.8);
    });

    markers.push(new mapboxgl.Marker({ color: '#37a7ff' }).setLngLat(origin.coordinates).addTo(map));
    markers.push(new mapboxgl.Marker({ color: '#f3f6f8' }).setLngLat(destination.coordinates).addTo(map));

    const coordinates = activeRoutes.flatMap(route => route.geometry.coordinates);
    const bounds = coordinates.reduce((b, coord) => b.extend(coord), new mapboxgl.LngLatBounds(coordinates[0], coordinates[0]));
    map.fitBounds(bounds, { padding: 55, duration: 700 });

    map.once('idle', () => scoreVisibleRoutes(activeRoutes));
  };

  if (map.loaded()) render();
  else map.once('load', render);
}

function toXY(coord, lat0) {
  const rad = Math.PI / 180;
  return [coord[0] * 111320 * Math.cos(lat0 * rad), coord[1] * 110540];
}

function pointSegmentDistanceMeters(point, a, b) {
  const lat0 = point[1];
  const p = toXY(point, lat0);
  const p1 = toXY(a, lat0);
  const p2 = toXY(b, lat0);
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - p1[0], p[1] - p1[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - p1[0]) * dx + (p[1] - p1[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - (p1[0] + t * dx), p[1] - (p1[1] + t * dy));
}

function pointToRouteDistanceMeters(point, coordinates) {
  let best = Infinity;
  for (let i = 1; i < coordinates.length; i += 1) {
    best = Math.min(best, pointSegmentDistanceMeters(point, coordinates[i - 1], coordinates[i]));
    if (best <= ROUTE_MATCH_METERS) break;
  }
  return best;
}

function loadedAlprPoints() {
  if (!map?.getSource(ALPR_SOURCE_ID)) return [];
  const features = map.querySourceFeatures(ALPR_SOURCE_ID, { sourceLayer: ALPR_SOURCE_LAYER });
  const seen = new Set();
  const points = [];
  features.forEach(feature => {
    if (feature.geometry?.type !== 'Point') return;
    const coord = feature.geometry.coordinates;
    const key = `${coord[0].toFixed(6)},${coord[1].toFixed(6)}`;
    if (seen.has(key)) return;
    seen.add(key);
    points.push(coord);
  });
  return points;
}

function exposureCount(route, points) {
  return points.reduce((count, point) => count + (pointToRouteDistanceMeters(point, route.geometry.coordinates) <= ROUTE_MATCH_METERS ? 1 : 0), 0);
}

function generalizedCenter(coord) {
  return [
    Math.round(coord[0] * 1000) / 1000,
    Math.round(coord[1] * 1000) / 1000
  ];
}

function circlePolygon(center, radiusMeters, steps = 28) {
  const [lng, lat] = center;
  const latRadians = lat * Math.PI / 180;
  const metersPerDegreeLat = 110540;
  const metersPerDegreeLng = Math.max(1, 111320 * Math.cos(latRadians));
  const coordinates = [];
  for (let i = 0; i <= steps; i += 1) {
    const theta = (i / steps) * Math.PI * 2;
    coordinates.push([
      lng + (Math.cos(theta) * radiusMeters) / metersPerDegreeLng,
      lat + (Math.sin(theta) * radiusMeters) / metersPerDegreeLat
    ]);
  }
  return { type: 'Polygon', coordinates: [coordinates] };
}

function pointsNearAnyActiveRoute(points) {
  return points.filter(point => activeRoutes.some(route => pointToRouteDistanceMeters(point, route.geometry.coordinates) <= ROUTE_MATCH_METERS));
}

function showApproximateAlprAreas(points) {
  if (!map?.getSource(ALPR_DISPLAY_SOURCE_ID)) return;
  const seen = new Set();
  const features = [];

  points.forEach(point => {
    const center = generalizedCenter(point);
    const key = `${center[0].toFixed(3)},${center[1].toFixed(3)}`;
    if (seen.has(key)) return;
    seen.add(key);
    features.push({
      type: 'Feature',
      properties: { type: 'ALPR', confidence: 'source-only' },
      geometry: circlePolygon(center, DISPLAY_RADIUS_METERS)
    });
  });

  map.getSource(ALPR_DISPLAY_SOURCE_ID).setData({ type: 'FeatureCollection', features });
}

function scoreVisibleRoutes(routes) {
  try {
    const points = loadedAlprPoints();
    if (!points.length) {
      setMessage('Routes found. Known-ALPR data is still loading; route exposure could not be scored on this pass.', 'success');
      return;
    }
    const counts = routes.map(route => exposureCount(route, points));
    renderRouteCards(routes, counts);
    showApproximateAlprAreas(pointsNearAnyActiveRoute(points));
    const best = Math.min(...counts);
    setMessage(`Routes scored against the current known-ALPR dataset. Lowest candidate on this trip: ${best} known ALPR location${best === 1 ? '' : 's'}.`, 'success');
  } catch (error) {
    console.warn('ALPR scoring proof failed:', error);
    setMessage('Routes found. ALPR exposure scoring is temporarily unavailable.', 'success');
  }
}

function renderRouteCards(routes, exposureCounts = null) {
  const sorted = [...routes].sort((a, b) => a.duration - b.duration);
  const fastestDisplayMinutes = minutes(sorted[0].duration);
  routeResults.innerHTML = '';

  sorted.slice(0, 3).forEach((route, index) => {
    const originalIndex = routes.indexOf(route);
    const count = exposureCounts ? exposureCounts[originalIndex] : null;
    const displayMinutes = minutes(route.duration);
    const card = document.createElement('article');
    card.className = `route-result ${index === 0 ? 'fastest' : ''}`;
    const deltaMinutes = Math.max(0, displayMinutes - fastestDisplayMinutes);
    const delta = index === 0 ? '' : `+${deltaMinutes} min vs fastest`;
    const label = index === 0 ? 'Fastest' : `Alternate route ${index}`;
    card.innerHTML = `
      <div>
        <span class="route-result-label">${label}</span>
        <strong>${displayMinutes} min</strong>
      </div>
      <div class="route-result-meta">
        <span>${miles(route.distance)} mi</span>
        ${delta ? `<span>${delta}</span>` : '<span>Baseline</span>'}
        <span>${count === null ? 'Checking known ALPR exposure…' : `${count} known ALPR location${count === 1 ? '' : 's'}`}</span>
      </div>`;
    routeResults.appendChild(card);
  });
}

routeForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const formData = new FormData(routeForm);
  const from = String(formData.get('from') || '').trim();
  const to = String(formData.get('to') || '').trim();

  if (from.length < 3 || to.length < 3) {
    setMessage('Enter a starting point and destination.', 'error');
    return;
  }

  routeButton.disabled = true;
  routeButton.textContent = 'Checking route…';
  routeResults.innerHTML = '';
  setMessage('Finding real driving routes…');

  try {
    const [origin, destination] = await Promise.all([geocode(from), geocode(to)]);
    const routes = await getRoutes(origin, destination);
    renderRouteCards(routes);
    drawRoutes(routes, origin, destination);
    setMessage(`Showing candidate routes from ${origin.label} to ${destination.label}. Loading known-ALPR exposure…`, 'success');
  } catch (error) {
    console.error(error);
    setMessage(error.message || 'We could not calculate that route. Try a more specific address or city.', 'error');
  } finally {
    routeButton.disabled = false;
    routeButton.textContent = 'Show route choices';
  }
});