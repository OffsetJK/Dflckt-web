const MAPBOX_TOKEN = 'pk.eyJ1IjoizGZsY2t0MSIsImEiOiJjbXQ3bjFmbXUwMnM5MnhvbGV6bW1iOGtkIn0.heLVAWAqfKVjWhie8hqjEA';

const routeForm = document.querySelector('[data-route-form]');
const routeMessage = document.querySelector('[data-route-message]');
const routeResults = document.querySelector('[data-route-results]');
const routeButton = document.querySelector('[data-route-submit]');

let map;
let markers = [];

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

function clearMapRoutes() {
  if (!map) return;
  ['route-fastest', 'route-alt-1', 'route-alt-2'].forEach(id => {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  });
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

  const render = () => {
    clearMapRoutes();
    const colors = ['#37a7ff', '#667481', '#414b56'];
    const ids = ['route-fastest', 'route-alt-1', 'route-alt-2'];

    routes.slice(0, 3).forEach((route, index) => {
      addRouteLayer(ids[index], route.geometry, colors[index], index === 0 ? 6 : 4, index === 0 ? 0.95 : 0.8);
    });

    markers.push(new mapboxgl.Marker({ color: '#37a7ff' }).setLngLat(origin.coordinates).addTo(map));
    markers.push(new mapboxgl.Marker({ color: '#f3f6f8' }).setLngLat(destination.coordinates).addTo(map));

    const coordinates = routes.flatMap(route => route.geometry.coordinates);
    const bounds = coordinates.reduce((b, coord) => b.extend(coord), new mapboxgl.LngLatBounds(coordinates[0], coordinates[0]));
    map.fitBounds(bounds, { padding: 55, duration: 700 });
  };

  if (map.loaded()) render();
  else map.once('load', render);
}

function renderRouteCards(routes) {
  const sorted = [...routes].sort((a, b) => a.duration - b.duration);
  routeResults.innerHTML = '';

  sorted.slice(0, 3).forEach((route, index) => {
    const card = document.createElement('article');
    card.className = `route-result ${index === 0 ? 'fastest' : ''}`;
    const delta = index === 0 ? '' : `+${Math.max(0, minutes(route.duration - sorted[0].duration))} min vs fastest`;
    card.innerHTML = `
      <div>
        <span class="route-result-label">${index === 0 ? 'Fastest' : `Candidate ${index + 1}`}</span>
        <strong>${minutes(route.duration)} min</strong>
      </div>
      <div class="route-result-meta">
        <span>${miles(route.distance)} mi</span>
        ${delta ? `<span>${delta}</span>` : '<span>Baseline</span>'}
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
    setMessage(`Showing candidate routes from ${origin.label} to ${destination.label}. Surveillance scoring is not applied yet.`, 'success');
  } catch (error) {
    console.error(error);
    setMessage(error.message || 'We could not calculate that route. Try a more specific address or city.', 'error');
  } finally {
    routeButton.disabled = false;
    routeButton.textContent = 'Show route choices';
  }
});