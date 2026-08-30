#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const PRODUCTION_ORIGIN = 'https://dflckt.com';
const ROUTE_PAGE = `${PRODUCTION_ORIGIN}/check-your-route.html`;
const MAPBOX_DIRECTIONS_PATH = '/directions/v5/';
const ALPR_INDEX_ORIGIN = 'https://tiles.dontgetflocked.com';
const ALPR_INDEX_PATH = '/cameras-us-hourly-index.bin';
const MAX_WAIT_MS = 120000;

const routeCases = [
  {
    name: 'Rochester',
    from: '2392 Richwood Rd, Auburn Hills, MI',
    to: '6377 Orion Rd, Rochester, MI'
  },
  {
    name: 'Midway to O\'Hare',
    from: 'Chicago Midway International Airport',
    to: "Chicago O'Hare International Airport"
  }
];

function readExperimentalRouteSource() {
  const token = process.env.MAPBOX_PUBLIC_TOKEN;
  if (!token) throw new Error('Missing MAPBOX_PUBLIC_TOKEN');

  const sourcePath = path.join(__dirname, '..', 'route.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  if (!source.includes('__MAPBOX_PUBLIC_TOKEN__')) {
    throw new Error('Mapbox token placeholder not found in experimental route.js');
  }
  return source.replace('__MAPBOX_PUBLIC_TOKEN__', token);
}

function roundMinutes(seconds) {
  return Math.max(1, Math.round(seconds / 60));
}

function displayMiles(meters) {
  return Number((meters / 1609.344).toFixed(meters < 16093 ? 1 : 0));
}

async function parseRouteCards(cards) {
  return Promise.all(cards.map(async card => {
    const text = ((await card.textContent()) || '').replace(/\s+/g, ' ').trim();
    const label = ((await card.locator('.route-result-label').textContent()) || '').trim();
    const fastest = await card.evaluate(element => element.classList.contains('fastest'));
    const privacy = await card.evaluate(element => element.classList.contains('privacy'));
    const durationText = (await card.locator('strong').textContent()) || '';
    const distanceText = (await card.locator('.route-result-meta span').first().textContent()) || '';
    const durationMatch = durationText.match(/(\d+)\s+min\b/);
    const distanceMatch = distanceText.match(/([\d.]+)\s+mi\b/);
    const exposureText = (await card.locator('.route-result-meta span').nth(2).textContent()) || '';
    const exposureMatch = exposureText.match(/(\d+) known ALPR location/);
    return {
      label: label || 'Unknown',
      fastest,
      privacy: privacy || text.includes('Lower exposure'),
      distanceMiles: distanceMatch ? Number(distanceMatch[1]) : null,
      durationMinutes: durationMatch ? Number(durationMatch[1]) : null,
      exposure: exposureMatch ? Number(exposureMatch[1]) : null
    };
  }));
}

function matchResponseRoute(card, responseRoutes) {
  if (!card) return [];
  return responseRoutes.filter(route =>
    Math.abs(displayMiles(route.route.distance) - card.distanceMiles) < 0.1 &&
    roundMinutes(route.route.duration) === card.durationMinutes
  );
}

function sanitizedRouteMetadata(responseRoute) {
  return {
    sequence: responseRoute.sequence,
    alternatives: responseRoute.alternatives,
    routeCount: responseRoute.routeCount,
    roundedDistanceMiles: displayMiles(responseRoute.route.distance),
    roundedDurationMinutes: roundMinutes(responseRoute.route.duration)
  };
}

function throwMatchError(caseName, cardName, card, candidates, responseMetadata) {
  throw new Error(JSON.stringify({
    case: caseName,
    card: cardName,
    directionsResponsesObserved: responseMetadata.length,
    directionsResponsesParsed: responseMetadata.filter(response => response.parseSuccess).length,
    directionsResponsesDiscardedOrFailed: responseMetadata.filter(response => !response.parseSuccess).length,
    responses: responseMetadata,
    card: {
      distanceMiles: card?.distanceMiles ?? null,
      durationMinutes: card?.durationMinutes ?? null
    },
    matchingCandidateCount: candidates.length,
    candidates: candidates.map(sanitizedRouteMetadata)
  }));
}

async function drainRouteResponseTasks(routeResponseTasks) {
  let drainedCount = 0;
  while (drainedCount < routeResponseTasks.length) {
    const pendingTasks = routeResponseTasks.slice(drainedCount);
    drainedCount += pendingTasks.length;
    await Promise.all(pendingTasks);
  }
}

function distanceMeters(a, b) {
  const radians = Math.PI / 180;
  const lat1 = a[1] * radians;
  const lat2 = b[1] * radians;
  const dLat = (b[1] - a[1]) * radians;
  const dLng = (b[0] - a[0]) * radians;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function pointAtRouteFraction(route, fraction) {
  const coordinates = route.geometry.coordinates;
  const segmentLengths = coordinates.slice(1).map((coordinate, index) => distanceMeters(coordinates[index], coordinate));
  const totalLength = segmentLengths.reduce((sum, length) => sum + length, 0);
  let remaining = totalLength * fraction;
  for (let index = 0; index < segmentLengths.length; index += 1) {
    const segmentLength = segmentLengths[index];
    if (remaining <= segmentLength) {
      const start = coordinates[index];
      const end = coordinates[index + 1];
      const ratio = segmentLength ? remaining / segmentLength : 0;
      return [start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio];
    }
    remaining -= segmentLength;
  }
  return coordinates[coordinates.length - 1];
}

function buildSyntheticAlprFixture(routes) {
  const fastestRoute = [...routes].sort((a, b) => a.duration - b.duration)[0];
  const fractions = [0.2, 0.22, 0.55, 0.57, 0.82, 0.84];
  const points = fractions.map(fraction => pointAtRouteFraction(fastestRoute, fraction))
    .sort((a, b) => a[1] - b[1]);
  const buffer = Buffer.alloc(16 + 9 * points.length);
  buffer.write('FHIX', 0, 'ascii');
  buffer.writeUInt32LE(1, 4);
  buffer.writeUInt32LE(points.length, 8);
  points.forEach((point, index) => {
    buffer.writeInt32LE(Math.round(point[1] * 1e6), 16 + index * 4);
    buffer.writeInt32LE(Math.round(point[0] * 1e6), 16 + points.length * 4 + index * 4);
  });
  return buffer;
}

function operationalReasonableness(route, fastestRoute) {
  if (!route || !fastestRoute || !route.geometry?.coordinates?.length) {
    return { reasonable: false, summary: 'route geometry unavailable' };
  }

  const coordinates = route.geometry.coordinates;
  let geometryLength = 0;
  let reverseTurns = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    geometryLength += distanceMeters(coordinates[index - 1], coordinates[index]);
    if (index < coordinates.length - 1) {
      const previous = [
        coordinates[index][0] - coordinates[index - 1][0],
        coordinates[index][1] - coordinates[index - 1][1]
      ];
      const next = [
        coordinates[index + 1][0] - coordinates[index][0],
        coordinates[index + 1][1] - coordinates[index][1]
      ];
      const previousLength = Math.hypot(...previous);
      const nextLength = Math.hypot(...next);
      if (previousLength > 0 && nextLength > 0 &&
          (previous[0] * next[0] + previous[1] * next[1]) / (previousLength * nextLength) < -0.85) {
        reverseTurns += 1;
      }
    }
  }

  const distanceRatio = route.distance / Math.max(1, fastestRoute.distance);
  const durationRatio = route.duration / Math.max(1, fastestRoute.duration);
  const geometryRatio = geometryLength / Math.max(1, route.distance);
  const reasonable = distanceRatio <= 2.25 && durationRatio <= 2 && geometryRatio <= 1.35 && reverseTurns <= 3;
  return {
    reasonable,
    summary: reasonable
      ? 'distance, duration, geometry, and reversal checks passed'
      : 'distance, duration, geometry, or reversal check failed'
  };
}

function summarizeV2Diagnostics(events, fastestExposure, fastestDuration) {
  const accepted = events.filter(event => event.kind === 'accepted');
  const rejected = events.filter(event => event.kind === 'rejected');
  const skipped = events.filter(event => event.kind === 'skipped');
  const last = events[events.length - 1] || {};
  const finalExposure = Number.isInteger(last.exposureAfter) ? last.exposureAfter : fastestExposure;
  const finalDuration = Number.isFinite(last.resultingDuration) ? last.resultingDuration : fastestDuration;
  return {
    clustersIdentified: events.reduce((max, event) => Math.max(max, event.clusterNumber || 0), 0),
    clustersProcessed: accepted.length + rejected.length,
    clustersSkipped: skipped.length,
    acceptedWaypointCount: accepted.reduce((max, event) => Math.max(max, event.cumulativeWaypointCount || 0), 0),
    generatedV2RequestCount: null,
    finalExposure,
    finalDurationSeconds: finalDuration,
    maxDurationRuleRespected: finalDuration <= fastestDuration * 2
  };
}

async function prepareFixtureBufferForCase(testCase, initialRoutesPromise) {
  return buildSyntheticAlprFixture(await initialRoutesPromise);
}

async function runBrowserCase(browser, testCase, experimental, fixtureState) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.setDefaultTimeout(MAX_WAIT_MS);
  const page = await context.newPage();
  await page.setExtraHTTPHeaders({ 'Cache-Control': 'no-cache' });

  let routeIntercepted = false;
  const routeResponses = [];
  const routeResponseTasks = [];
  const responseMetadata = [];
  let resolveInitialRoutes;
  const initialRoutesPromise = new Promise(resolve => { resolveInitialRoutes = resolve; });
  const alprDiagnostics = {
    datasetRequestObserved: false,
    httpStatus: null,
    loadParseSuccess: false,
    scoringSuccess: false,
    failureStage: null
  };
  let directionsResponseSequence = 0;
  const directionsRequests = { initial: 0, generated: 0 };
  const v2Events = [];

  page.on('console', async message => {
    const label = message.text();
    if (!label.includes('[DFLCKT ALPR cluster V2')) return;
    const args = message.args();
    if (args.length < 2) return;
    const value = await args[1].jsonValue().catch(() => null);
    if (!value) return;
    const kind = label.includes('accepted') ? 'accepted' : label.includes('rejected') ? 'rejected' : 'skipped';
    v2Events.push({
      kind,
      clusterNumber: value.clusterNumber,
      exposureBefore: value.exposureBefore,
      exposureAfter: value.exposureAfter,
      cumulativeWaypointCount: value.cumulativeWaypointCount,
      resultingDuration: value.resultingDuration
    });
  });

  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === ALPR_INDEX_ORIGIN && url.pathname === ALPR_INDEX_PATH) {
      alprDiagnostics.datasetRequestObserved = true;
      return;
    }
    if (url.origin !== 'https://api.mapbox.com' || !url.pathname.startsWith(MAPBOX_DIRECTIONS_PATH)) return;
    if (url.searchParams.get('alternatives') === 'true') directionsRequests.initial += 1;
    if (url.searchParams.get('alternatives') === 'false') directionsRequests.generated += 1;
  });

  page.on('response', async response => {
    const url = new URL(response.url());
    if (url.origin === ALPR_INDEX_ORIGIN && url.pathname === ALPR_INDEX_PATH) {
      alprDiagnostics.httpStatus = response.status();
      if (!response.ok()) alprDiagnostics.failureStage = 'load';
      return;
    }
    if (url.origin !== 'https://api.mapbox.com' || !url.pathname.startsWith(MAPBOX_DIRECTIONS_PATH)) return;
    const sequence = ++directionsResponseSequence;
    const alternativesValue = url.searchParams.get('alternatives');
    const metadata = {
      sequence,
      status: response.status(),
      alternatives: alternativesValue === 'true' ? true : alternativesValue === 'false' ? false : null,
      parseSuccess: false,
      routeCount: null,
      routes: []
    };
    responseMetadata.push(metadata);
    if (!response.ok()) return;
    routeResponseTasks.push(response.json().then(body => {
      metadata.parseSuccess = true;
      metadata.routeCount = Array.isArray(body?.routes) ? body.routes.length : 0;
      metadata.routes = Array.isArray(body?.routes)
        ? body.routes.map(route => ({
          roundedDistanceMiles: displayMiles(route.distance),
          roundedDurationMinutes: roundMinutes(route.duration)
        }))
        : [];
      if (metadata.alternatives === true && Array.isArray(body?.routes) && body.routes.length) {
        resolveInitialRoutes(body.routes);
      }
      if (body?.routes?.length) {
        routeResponses.push(...body.routes.map(route => ({
          route,
          sequence,
          alternatives: metadata.alternatives,
          routeCount: body.routes.length
        })));
      }
    }).catch(() => {}));
  });

  if (experimental) {
    const source = readExperimentalRouteSource();
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === ALPR_INDEX_ORIGIN && url.pathname === ALPR_INDEX_PATH) {
        alprDiagnostics.datasetRequestObserved = true;
        if (!fixtureState.buffer) {
          throw new Error(`${testCase.name}: synthetic ALPR fixture was not prepared before interception`);
        }
        await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: fixtureState.buffer });
        return;
      }
      if (url.origin === PRODUCTION_ORIGIN && url.pathname === '/route.js') {
        routeIntercepted = true;
        await route.fulfill({
          status: 200,
          contentType: 'application/javascript; charset=utf-8',
          headers: { 'cache-control': 'no-store' },
          body: source
        });
        return;
      }
      await route.continue();
    });
  } else {
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === ALPR_INDEX_ORIGIN && url.pathname === ALPR_INDEX_PATH) {
        alprDiagnostics.datasetRequestObserved = true;
        if (!fixtureState.buffer) {
          throw new Error(`${testCase.name}: synthetic ALPR fixture was not prepared before interception`);
        }
        await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: fixtureState.buffer });
        return;
      }
      await route.continue();
    });
  }

  try {
    if (!fixtureState.buffer) {
      const preparedRoutes = await initialRoutesPromise;
      fixtureState.buffer = await prepareFixtureBufferForCase(testCase, Promise.resolve(preparedRoutes));
    }
    await page.goto(ROUTE_PAGE, { waitUntil: 'domcontentloaded' });
    const markerPresent = await page.evaluate(() => typeof window.__DFLCKT_V2__ === 'object' && window.__DFLCKT_V2__ !== null);
    if (experimental && (!routeIntercepted || !markerPresent)) {
      throw new Error(`${testCase.name}: experimental V2 implementation was not positively identified`);
    }
    if (!experimental && markerPresent) {
      throw new Error(`${testCase.name}: control unexpectedly exposed the V2 marker`);
    }

    await page.locator('input[name="from"]').fill(testCase.from);
    await page.locator('input[name="to"]').fill(testCase.to);
    await page.locator('[data-route-submit]').click();
    const scoringState = await page.waitForFunction(() => {
      const message = document.querySelector('[data-route-message]')?.textContent || '';
      const cards = [...document.querySelectorAll('[data-route-results] .route-result')];
      const hasNumericExposure = cards.some(card => /\d+ known ALPR location/.test(card.querySelector('.route-result-meta span:nth-child(3)')?.textContent || ''));
      if ((message.includes('Lowest found exposure') || message.includes('No lower-exposure route')) && hasNumericExposure) return 'success';
      if (message.includes('could not be loaded') || message.includes('failed')) return 'failure';
      return false;
    }).then(handle => handle.jsonValue());

    if (scoringState === 'failure') {
      alprDiagnostics.failureStage = alprDiagnostics.failureStage || (alprDiagnostics.httpStatus === null ? 'request' : 'load/parse');
      throw new Error(JSON.stringify({
        case: testCase.name,
        implementation: experimental ? 'V2 experimental' : 'V1 production control',
        error: 'ALPR scoring failed',
        alprDiagnostics
      }));
    }
    alprDiagnostics.loadParseSuccess = true;
    alprDiagnostics.scoringSuccess = true;

    await drainRouteResponseTasks(routeResponseTasks);
    const cards = await parseRouteCards(await page.locator('[data-route-results] .route-result').all());
    if (!cards.length) throw new Error(`${testCase.name}: no user-facing route results rendered`);
    const fastestCard = cards.find(card => card.fastest) || cards[0];
    const privacyCard = cards.find(card => card.privacy) || null;
    const fastestCandidates = matchResponseRoute(fastestCard, routeResponses);
    const privacyCandidates = matchResponseRoute(privacyCard, routeResponses);
    if (fastestCandidates.length !== 1) {
      throwMatchError(testCase.name, 'fastest', fastestCard, fastestCandidates, responseMetadata);
    }
    if (privacyCard && privacyCandidates.length !== 1) {
      throwMatchError(testCase.name, 'privacy', privacyCard, privacyCandidates, responseMetadata);
    }
    const fastestRoute = fastestCandidates[0].route;
    const privacyRoute = privacyCandidates[0]?.route || null;

    const result = {
      case: testCase.name,
      implementation: experimental ? 'V2 experimental' : 'V1 production control',
      fastest: {
        distanceMiles: fastestCard.distanceMiles,
        durationMinutes: fastestCard.durationMinutes,
        knownAlprExposure: fastestCard.exposure,
        operationallyReasonable: operationalReasonableness(fastestRoute, fastestRoute).reasonable
      },
      privacy: privacyCard ? {
        selected: true,
        distanceMiles: privacyCard.distanceMiles,
        durationMinutes: privacyCard.durationMinutes,
        knownAlprExposure: privacyCard.exposure,
        addedMinutes: privacyCard.durationMinutes - fastestCard.durationMinutes,
        exposureReductionPercentage: fastestCard.exposure > 0
          ? Number(((fastestCard.exposure - privacyCard.exposure) / fastestCard.exposure * 100).toFixed(1))
          : 0,
        operationallyReasonable: operationalReasonableness(privacyRoute, fastestRoute).reasonable
      } : { selected: false },
      directionsRequests: {
        initialConventional: directionsRequests.initial,
        generatedPrivacy: directionsRequests.generated,
        total: directionsRequests.initial + directionsRequests.generated
      },
      alprDiagnostics
    };

    if (experimental) {
      const diagnostics = summarizeV2Diagnostics(v2Events, fastestCard.exposure, fastestRoute.duration);
      diagnostics.generatedV2RequestCount = directionsRequests.generated;
      result.v2Diagnostics = diagnostics;
    }
    return result;
  } finally {
    await context.close();
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const results = [];
    for (const testCase of routeCases) {
      const fixtureState = { buffer: null };
      const preflight = await (async () => {
        const routePage = await browser.newPage();
        try {
          const preflightRoutes = await new Promise((resolve, reject) => {
            const context = routePage.context();
            const routeHandler = (request) => {
              const url = new URL(request.url());
              if (url.origin !== 'https://api.mapbox.com' || !url.pathname.startsWith(MAPBOX_DIRECTIONS_PATH)) return;
              if (url.searchParams.get('alternatives') !== 'true') return;
            };
            context.on('request', routeHandler);
            routePage.goto(ROUTE_PAGE, { waitUntil: 'domcontentloaded' }).catch(reject);
            routePage.on('console', () => {});
            setTimeout(() => {
              routePage.evaluate(() => {
                const form = document.querySelector('[data-route-form]');
                if (!form) return;
                const from = form.querySelector('input[name="from"]');
                const to = form.querySelector('input[name="to"]');
                if (from && to) {
                  from.value = testCase.from;
                  to.value = testCase.to;
                  form.dispatchEvent(new Event('submit', { cancelable: true }));
                }
              }).catch(reject);
            }, 0);
          });
          return preflightRoutes;
        } finally {
          await routePage.close();
        }
      })();
      const initialRoutesPromise = Promise.resolve(preflight);
      fixtureState.buffer = await prepareFixtureBufferForCase(testCase, initialRoutesPromise);
      results.push(await runBrowserCase(browser, testCase, false, fixtureState));
      results.push(await runBrowserCase(browser, testCase, true, fixtureState));
    }
    process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});