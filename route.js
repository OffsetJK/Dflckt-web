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
const PRIVACY_ROUTE_MAX_FACTOR = 2;
const DETOUR_OFFSETS_METERS = [900, 1500, 2200];

const routeForm = document.querySelector('[data-route-form]');
const routeMessage = document.querySelector('[data-route-message]');
const routeResults = document.querySelector('[data-route-results]');
const routeButton = document.querySelector('[data-route-submit]');

let map;
let markers = [];
let activeRoutes = [];
let lastOrigin = null;
let lastDestination = null;

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

async function getRouteViaWaypoint(origin, destination, waypoint) {
  const coords = `${origin.coordinates[0]},${origin.coordinates[1]};${waypoint[0]},${waypoint[1]};${destination.coordinates[0]},${destination.coordinates[1]}`;
  const url = new URL(`https://api.mapbox.com/directions/v5/mapbox/driving/${coords}`);
  url.searchParams.set('alternatives', 'false');
  url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('overview', 'full');
  url.searchParams.set('steps', 'false');
  url.searchParams.set('access_token', MAPBOX_TOKEN);

  const response = await fetch(url);
  if (!response.ok) throw await apiError(response, 'Lower-exposure route request failed');
  const data = await response.json();
  if (!data.routes || !data.routes.length) throw new Error('No detour route found');
  return data.routes[0];
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
  ['route-fastest', 'route-alt-1', 'route-alt-2', 'route-privacy'].forEach(id => {
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

function drawRouteSet(routes, origin, destination) {
  clearMapRoutes();
  ensureAlprSource();
  ensureApproximateAlprDisplay();

  const conventional = routes.filter(route => route._dflcktKind !== 'privacy');
  const privacy = routes.find(route => route._dflcktKind === 'privacy');

  conventional.slice(0, 3).forEach((route, index) => {
    const id = index === 0 ? 'route-fastest' : `route-alt-${index}`;
    const color = index === 0 ? '#37a7ff' : '#d85b5b';
    addRouteLayer(id, route.geometry, color, index === 0 ? 6 : 4, index === 0 ? 0.95 : 0.78);
  });

  if (privacy) {
    addRouteLayer('route-privacy', privacy.geometry, '#4bd16f', 6, 0.95);
  }

  markers.push(new mapboxgl.Marker({ color: '#37a7ff' }).setLngLat(origin.coordinates).addTo(map));
  markers.push(new mapboxgl.Marker({ color: '#f3f6f8' }).setLngLat(destination.coordinates).addTo(map));

  const coordinates = routes.flatMap(route => route.geometry.coordinates);
  const bounds = coordinates.reduce((b, coord) => b.extend(coord), new mapboxgl.LngLatBounds(coordinates[0], coordinates[0]));
  map.fitBounds(bounds, { padding: 55, duration: 700 });
}

function drawRoutes(routes, origin, destination) {
  ensureMap(origin.coordinates);
  lastOrigin = origin;
  lastDestination = destination;
  activeRoutes = routes.slice(0, 3);

  const render = () => {
    drawRouteSet(activeRoutes, origin, destination);
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

function cameraCentroid(points) {
  const total = points.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0]);
  return [total[0] / points.length, total[1] / points.length];
}

function closestRouteSegment(route, point) {
  const coords = route.geometry.coordinates;
  let best = { a: coords[0], b: coords[1], distance: Infinity };
  for (let i = 1; i < coords.length; i += 1) {
    const distance = pointSegmentDistanceMeters(point, coords[i - 1], coords[i]);
    if (distance < best.distance) best = { a: coords[i - 1], b: coords[i], distance };
  }
  return best;
}

function offsetPerpendicular(center, a, b, meters, side) {
  const lat0 = center[1];
  const p1 = toXY(a, lat0);
  const p2 = toXY(b, lat0);
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const length = Math.max(1, Math.hypot(dx, dy));
  const px = (-dy / length) * meters * side;
  const py = (dx / length) * meters * side;
  const rad = Math.PI / 180;
  const metersPerDegreeLng = Math.max(1, 111320 * Math.cos(lat0 * rad));
  return [
    center[0] + px / metersPerDegreeLng,
    center[1] + py / 110540
  ];
}

function detourWaypoints(fastestRoute, cameraPoints) {
  const center = cameraCentroid(cameraPoints);
  const segment = closestRouteSegment(fastestRoute, center);
  const waypoints = [];
  DETOUR_OFFSETS_METERS.forEach(distance => {
    waypoints.push(offsetPerpendicular(center, segment.a, segment.b, distance, 1));
    waypoints.push(offsetPerpendicular(center, segment.a, segment.b, distance, -1));
  });
  return waypoints;
}

async function buildGeneratedDetours(fastestRoute, cameraPoints, allPoints) {
  if (!lastOrigin || !lastDestination || !cameraPoints.length) return [];
  const waypoints = detourWaypoints(fastestRoute, cameraPoints);
  const results = await Promise.allSettled(
    waypoints.map(waypoint => getRouteViaWaypoint(lastOrigin, lastDestination, waypoint))
  );

  return results
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value)
    .filter(route => route.duration <= fastestRoute.duration * PRIVACY_ROUTE_MAX_FACTOR)
    .map(route => ({ route, count: exposureCount(route, allPoints), generated: true }));
}

function chooseBestExposureCandidate(candidates, fastestRoute) {
  const eligible = candidates.filter(candidate => candidate.route.duration <= fastestRoute.duration * PRIVACY_ROUTE_MAX_FACTOR);
  if (!eligible.length) return null;
  eligible.sort((a, b) => a.count - b.count || a.route.duration - b.route.duration);
  return eligible[0];
}

async function scoreVisibleRoutes(routes) {
  try {
    const points = loadedAlprPoints();
    if (!points.length) {
      setMessage('Routes found. Known-ALPR data is still loading; route exposure could not be scored on this pass.', 'success');
      return;
    }

    const sorted = [...routes].sort((a, b) => a.duration - b.duration);
    const fastestRoute = sorted[0];
    const fastestCount = exposureCount(fastestRoute, points);
    const conventionalCandidates = sorted.map(route => ({ route, count: exposureCount(route, points), generated: false }));

    renderRouteCards(sorted, conventionalCandidates.map(candidate => candidate.count));
    showApproximateAlprAreas(pointsNearAnyActiveRoute(points));

    const fastestCameraPoints = points.filter(point => pointToRouteDistanceMeters(point, fastestRoute.geometry.coordinates) <= ROUTE_MATCH_METERS);
    setMessage('Routes scored. Searching for the lowest known-exposure option within the 2× travel-time limit…', 'success');

    const generatedCandidates = fastestCameraPoints.length
      ? await buildGeneratedDetours(fastestRoute, fastestCameraPoints, points)
      : [];

    const allCandidates = [...conventionalCandidates, ...generatedCandidates];
    const best = chooseBestExposureCandidate(allCandidates, fastestRoute);

    routes.forEach(route => { delete route._dflcktKind; delete route._dflcktExposureCount; });
    generatedCandidates.forEach(candidate => { delete candidate.route._dflcktKind; delete candidate.route._dflcktExposureCount; });

    if (!best || best.count >= fastestCount) {
      activeRoutes = sorted.slice(0, 3);
      drawRouteSet(activeRoutes, lastOrigin, lastDestination);
      renderRouteCards(activeRoutes, activeRoutes.map(route => exposureCount(route, points)));
      showApproximateAlprAreas(pointsNearAnyActiveRoute(points));
      setMessage(`Routes scored. Fastest is already tied for the lowest known exposure on this trip: ${fastestCount} known ALPR location${fastestCount === 1 ? '' : 's'}.`, 'success');
      return;
    }

    best.route._dflcktKind = 'privacy';
    best.route._dflcktExposureCount = best.count;

    const remaining = allCandidates
      .filter(candidate => candidate.route !== fastestRoute && candidate.route !== best.route)
      .sort((a, b) => a.route.duration - b.route.duration);
    const alternate = remaining[0]?.route || null;

    activeRoutes = [fastestRoute];
    if (alternate) activeRoutes.push(alternate);
    activeRoutes.push(best.route);

    drawRouteSet(activeRoutes, lastOrigin, lastDestination);
    const counts = activeRoutes.map(route => route._dflcktExposureCount ?? exposureCount(route, points));
    renderRouteCards(activeRoutes, counts);
    showApproximateAlprAreas(pointsNearAnyActiveRoute(points));

    map.once('idle', () => {
      const refreshedPoints = loadedAlprPoints();
      if (!refreshedPoints.length) return;

      const refreshedCounts = activeRoutes.map(route => exposureCount(route, refreshedPoints));
      const refreshedFastestCount = refreshedCounts[0];
      const privacyIndex = activeRoutes.indexOf(best.route);
      const refreshedPrivacyCount = refreshedCounts[privacyIndex];

      if (refreshedPrivacyCount >= refreshedFastestCount) {
        delete best.route._dflcktKind;
        best.route._dflcktExposureCount = refreshedPrivacyCount;
      } else {
        best.route._dflcktKind = 'privacy';
        best.route._dflcktExposureCount = refreshedPrivacyCount;
      }

      renderRouteCards(activeRoutes, refreshedCounts);
      showApproximateAlprAreas(pointsNearAnyActiveRoute(refreshedPoints));
      setMessage(`Lowest known-exposure route: ${refreshedPrivacyCount} known ALPR location${refreshedPrivacyCount === 1 ? '' : 's'} vs ${refreshedFastestCount} on fastest.`, 'success');
    });
  } catch (error) {
    console.warn('ALPR scoring/search proof failed:', error);
    setMessage('Routes found. Lower-exposure route search is temporarily unavailable.', 'success');
  }
}

function renderRouteCards(routes, exposureCounts = null) {
  const fastestRoute = [...routes].sort((a, b) => a.duration - b.duration)[0];
  const fastestDisplayMinutes = minutes(fastestRoute.duration);
  routeResults.innerHTML = '';

  routes.slice(0, 3).forEach((route, index) => {
    const count = exposureCounts ? exposureCounts[index] : null;
    const displayMinutes = minutes(route.duration);
    const card = document.createElement('article');
    const isFastest = route === fastestRoute;
    const isPrivacy = route._dflcktKind === 'privacy';
    card.className = `route-result ${isFastest ? 'fastest' : ''} ${isPrivacy ? 'privacy' : ''}`.trim();
    const deltaMinutes = Math.max(0, displayMinutes - fastestDisplayMinutes);
    const delta = isFastest ? '' : `+${deltaMinutes} min vs fastest`;
    const label = isFastest ? 'Fastest' : (isPrivacy ? 'Lower exposure' : 'Alternate route');
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
    routes.forEach(route => { delete route._dflcktKind; delete route._dflcktExposureCount; });
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