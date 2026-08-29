#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');

const localMockMode = process.env.VALIDATE_V2_LOCAL === '1' || process.argv.includes('--mock');

if (!process.env.MAPBOX_PUBLIC_TOKEN && !localMockMode) {
  throw new Error('Missing MAPBOX_PUBLIC_TOKEN');
}

global.document = {
  querySelector: () => null,
  createElement: () => ({
    className: '',
    innerHTML: '',
    appendChild() {},
    addEventListener() {},
    remove() {},
    setAttribute() {}
  })
};

global.mapboxgl = {
  accessToken: '',
  Map: class {
    constructor() {}
    addControl() {}
    loaded() { return true; }
    once() {}
    getSource() { return null; }
    addSource() {}
    addLayer() {}
    removeLayer() {}
    removeSource() {}
    fitBounds() {}
  },
  NavigationControl: class {},
  Marker: class {
    setLngLat() { return this; }
    addTo() { return this; }
    remove() {}
  },
  LngLatBounds: class {
    constructor(a, b) { this.a = a; this.b = b; }
    extend() { return this; }
  }
};

const routeModule = require('../route.js');
const {
  geocode,
  getRoutes,
  alprPointsForRoutes,
  exposureCount,
  pointToRouteDistanceMeters,
  buildClusterGreedyDetoursV2,
  setRouteRuntimeContext,
  clearRouteRuntimeContext
} = routeModule;

const ROUTE_MATCH_METERS = 75;
const routeCases = [
  {
    label: '2392 Richwood Rd, Auburn Hills, MI → 6377 Orion Rd, Rochester, MI',
    from: '2392 Richwood Rd, Auburn Hills, MI',
    to: '6377 Orion Rd, Rochester, MI'
  },
  {
    label: "Chicago Midway International Airport → Chicago O'Hare International Airport",
    from: "Chicago Midway International Airport",
    to: "Chicago O'Hare International Airport"
  }
];

function createFastestRoute() {
  return {
    duration: 1800,
    distance: 23000,
    geometry: {
      coordinates: [
        [0.0, 0.0],
        [0.0012, 0.0012],
        [0.0032, 0.0032],
        [0.005, 0.005],
        [0.009, 0.009]
      ]
    }
  };
}

function createDetourRoute() {
  return {
    duration: 2100,
    distance: 26000,
    geometry: {
      coordinates: [
        [0.0, 0.0],
        [0.003, 0.0003],
        [0.005, 0.007],
        [0.009, 0.0085]
      ]
    }
  };
}

function buildMockPoints() {
  return [
    [0.001, 0.001],
    [0.002, 0.002],
    [0.0042, 0.0042],
    [0.0065, 0.0065],
    [0.0081, 0.0081]
  ];
}

function buildMockFetch() {
  let initialConventionalRequests = 0;
  let generatedV2Requests = 0;

  return {
    getCounts() {
      return {
        initialConventionalRequests,
        generatedV2Requests,
        totalDirectionsRequests: initialConventionalRequests + generatedV2Requests
      };
    },
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes('/directions/')) {
        if (initialConventionalRequests === 0) {
          initialConventionalRequests += 1;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              routes: [createFastestRoute()]
            })
          };
        }

        generatedV2Requests += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            routes: [createDetourRoute()]
          })
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ features: [{ geometry: { coordinates: [0, 0] }, properties: { full_address: 'mock' } }] })
      };
    }
  };
}

function msToMinutes(valueSeconds) {
  return Math.max(1, Math.round(valueSeconds / 60));
}

function metersToMiles(valueMeters) {
  return Number((valueMeters / 1609.344).toFixed(1));
}

async function evaluateCase(label, fromQuery, toQuery) {
  if (localMockMode) {
    const origin = { coordinates: [0.0, 0.0], label: fromQuery };
    const destination = { coordinates: [0.009, 0.009], label: toQuery };
    const fastestRoute = createFastestRoute();
    const allPoints = buildMockPoints();
    const cameraPoints = allPoints.filter(point => point[0] >= 0.0005 && point[0] <= 0.0085);
    const mock = buildMockFetch();
    global.fetch = mock.fetchImpl;
    setRouteRuntimeContext(origin, destination);

    await global.fetch('https://api.mapbox.com/directions/v5/mapbox/driving/seed');

    const result = await buildClusterGreedyDetoursV2(fastestRoute, cameraPoints, allPoints, 3, 18);
    const counts = mock.getCounts();
    const diagnostics = result.diagnostics || {};

    assert.equal(counts.initialConventionalRequests, 1, `${label}: initial conventional Directions requests must be exactly 1`);
    assert.ok(counts.generatedV2Requests <= 18, `${label}: generated V2 Directions requests must be <= 18`);
    assert.ok(counts.totalDirectionsRequests <= 19, `${label}: total Directions requests must be <= 19`);
    assert.ok(diagnostics && Number.isFinite(diagnostics.finalDuration), `${label}: final duration must be reported in diagnostics`);
    assert.ok(Number.isInteger(diagnostics.processedClusters) || diagnostics.processedClusters === 0, `${label}: processed clusters metadata required`);
    assert.ok(Number.isInteger(diagnostics.skippedClusters) || diagnostics.skippedClusters === 0, `${label}: skipped clusters metadata required`);
    assert.ok(Number.isInteger(diagnostics.generatedDirectionsRequests), `${label}: generated request count metadata required`);
    assert.ok(Number.isInteger(diagnostics.acceptedWaypointCount), `${label}: accepted waypoint count metadata required`);
    assert.ok(Number.isInteger(diagnostics.finalExposure), `${label}: final exposure metadata required`);
    assert.ok(typeof diagnostics.maxDurationRuleRespected === 'boolean', `${label}: maximum duration rule metadata required`);
    assert.equal(diagnostics.generatedDirectionsRequests, counts.generatedV2Requests, `${label}: generated V2 Directions request counters must agree`);

    const payload = {
      label,
      geocodingSuccess: true,
      initialConventionalDirectionsRequests: counts.initialConventionalRequests,
      generatedV2DirectionsRequests: counts.generatedV2Requests,
      totalDirectionsRequests: counts.totalDirectionsRequests,
      diagnosticSummary: diagnostics,
      finalRouteSelected: result.length > 0
    };

    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  const originalFetch = global.fetch;
  let totalDirectionsRequests = 0;

  global.fetch = async (...args) => {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    if (String(url).includes('api.mapbox.com/directions/v5/')) {
      totalDirectionsRequests += 1;
    }
    return originalFetch(...args);
  };

  try {
    let origin;
    let destination;
    let geocodingSuccess = false;

    try {
      [origin, destination] = await Promise.all([
        geocode(fromQuery),
        geocode(toQuery)
      ]);
      geocodingSuccess = true;
    } catch (error) {
      throw new Error(`Geocoding failed for ${label}: ${error.message}`);
    }

    const routes = await getRoutes(origin, destination);
    if (!Array.isArray(routes) || !routes.length) {
      throw new Error(`${label}: no conventional routes returned`);
    }

    const initialConventionalDirectionsRequests = totalDirectionsRequests;
    assert.equal(initialConventionalDirectionsRequests, 1, `${label}: initial conventional Directions requests must be exactly 1`);

    const sortedRoutes = [...routes].sort((a, b) => a.duration - b.duration);
    const fastestRoute = sortedRoutes[0];
    const allPoints = await alprPointsForRoutes(routes);
    const fastestKnownExposure = exposureCount(fastestRoute, allPoints);
    const fastestCameraPoints = allPoints.filter(point => pointToRouteDistanceMeters(point, fastestRoute.geometry.coordinates) <= ROUTE_MATCH_METERS);

    setRouteRuntimeContext(origin, destination);
    const v2Result = await buildClusterGreedyDetoursV2(fastestRoute, fastestCameraPoints, allPoints, 3, 18);
    const diagnostics = (v2Result && v2Result.diagnostics) || {};

    const generatedV2DirectionsRequests = totalDirectionsRequests - initialConventionalDirectionsRequests;
    const totalDirectionsCount = totalDirectionsRequests;
    assert.ok(generatedV2DirectionsRequests <= 18, `${label}: generated V2 Directions requests must be <= 18`);
    assert.ok(totalDirectionsCount <= 19, `${label}: total Directions requests must be <= 19`);

    const selectedV2Route = Array.isArray(v2Result) && v2Result.length ? (v2Result[0].route || v2Result[0]) : fastestRoute;
    const finalV2Route = selectedV2Route || fastestRoute;
    const finalV2Exposure = diagnostics.finalExposure ?? exposureCount(finalV2Route, allPoints);
    const finalV2Duration = diagnostics.finalDuration ?? finalV2Route.duration;
    const finalV2Distance = finalV2Route.distance ?? 0;
    const addedMinutes = Math.max(0, msToMinutes(finalV2Duration - fastestRoute.duration));
    const percentageExposureReduction = fastestKnownExposure > 0 ? ((fastestKnownExposure - finalV2Exposure) / fastestKnownExposure) * 100 : 0;
    const lowerExposureSelected = finalV2Exposure < fastestKnownExposure;

    const payload = {
      label,
      geocodingSuccess,
      fastestDurationSeconds: fastestRoute.duration,
      fastestDurationMinutes: msToMinutes(fastestRoute.duration),
      fastestDistanceMeters: fastestRoute.distance,
      fastestDistanceMiles: metersToMiles(fastestRoute.distance),
      fastestKnownExposure: fastestKnownExposure,
      totalClustersIdentified: diagnostics.totalClustersIdentified ?? 0,
      processedClusters: diagnostics.processedClusters ?? 0,
      skippedClusters: diagnostics.skippedClusters ?? 0,
      acceptedWaypointCount: diagnostics.acceptedWaypointCount ?? 0,
      generatedV2DirectionsRequests,
      initialConventionalDirectionsRequests,
      totalDirectionsRequests: totalDirectionsCount,
      finalV2Exposure,
      finalV2DurationSeconds: finalV2Duration,
      finalV2DurationMinutes: msToMinutes(finalV2Duration),
      finalV2DistanceMeters: finalV2Distance,
      finalV2DistanceMiles: metersToMiles(finalV2Distance),
      addedMinutes,
      percentageExposureReduction,
      maxDurationRuleRespected: diagnostics.maxDurationRuleRespected ?? (finalV2Duration <= fastestRoute.duration * 2),
      lowerExposureRouteSelected: lowerExposureSelected,
      v2Diagnostics: diagnostics
    };

    console.log(JSON.stringify(payload, null, 2));
    return payload;
  } catch (error) {
    console.error(JSON.stringify({
      label,
      geocodingSuccess: false,
      error: error && error.message ? error.message : String(error)
    }, null, 2));
    throw error;
  } finally {
    clearRouteRuntimeContext();
    global.fetch = originalFetch;
  }
}

(async () => {
  clearRouteRuntimeContext();
  for (const testCase of routeCases) {
    await evaluateCase(testCase.label, testCase.from, testCase.to);
  }
})().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exitCode = 1;
});
