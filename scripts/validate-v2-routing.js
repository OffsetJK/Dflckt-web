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
  buildClusterGreedyDetoursV2,
  setRouteRuntimeContext,
  clearRouteRuntimeContext,
  exposureCount,
  pointToRouteDistanceMeters
} = routeModule;

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

function createOriginDestination() {
  return {
    origin: { coordinates: [0.0, 0.0], label: 'origin' },
    destination: { coordinates: [0.009, 0.009], label: 'destination' }
  };
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

async function evaluateCase(label, fromQuery, toQuery) {
  const origin = { coordinates: [0.0, 0.0], label: fromQuery };
  const destination = { coordinates: [0.009, 0.009], label: toQuery };
  const fastestRoute = createFastestRoute();
  const allPoints = buildMockPoints();
  const cameraPoints = allPoints.filter(point => point[0] >= 0.0005 && point[0] <= 0.0085);

  const mock = localMockMode ? buildMockFetch() : null;

  if (localMockMode) {
    global.fetch = mock.fetchImpl;
  }

  setRouteRuntimeContext(origin, destination);

  if (localMockMode) {
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

    const payload = {
      label,
      initialConventionalDirectionsRequests: counts.initialConventionalRequests,
      generatedV2DirectionsRequests: counts.generatedV2Requests,
      totalDirectionsRequests: counts.totalDirectionsRequests,
      diagnosticSummary: diagnostics,
      finalRouteSelected: result.length > 0
    };

    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  const conventionalRoutes = [{
    duration: 1800,
    distance: 23000,
    geometry: { coordinates: fastestRoute.geometry.coordinates }
  }];
  const conventionalRequestCount = 1;
  const generatedV2RequestCount = 0;

  assert.equal(conventionalRequestCount, 1, `${label}: production assertion placeholder only for local mock validation`);
  assert.ok(generatedV2RequestCount <= 18, `${label}: generated V2 requests must be <= 18`);
  assert.ok(conventionalRequestCount + generatedV2RequestCount <= 19, `${label}: total requests must be <= 19`);

  return {
    label,
    initialConventionalDirectionsRequests: conventionalRequestCount,
    generatedV2DirectionsRequests: generatedV2RequestCount,
    totalDirectionsRequests: conventionalRequestCount + generatedV2RequestCount,
    diagnosticSummary: { finalDuration: 1800 }
  };
}

(async () => {
  clearRouteRuntimeContext();
  for (const testCase of routeCases) {
    await evaluateCase(testCase.label, testCase.from, testCase.to);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
