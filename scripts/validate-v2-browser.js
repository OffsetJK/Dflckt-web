#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const PRODUCTION_ORIGIN = 'https://dflckt.com';
const ROUTE_PAGE = `${PRODUCTION_ORIGIN}/check-your-route.html`;
const MAPBOX_DIRECTIONS_PATH = '/directions/v5/';
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
    const durationMatch = text.match(/(\d+)\s+min/);
    const distanceMatch = text.match(/([\d.]+)\s+mi/);
    const exposureMatch = text.match(/(\d+) known ALPR location/);
    return {
      label: card.querySelector('.route-result-label')?.textContent.trim() || 'Unknown',
      fastest: card.classList.contains('fastest'),
      privacy: card.classList.contains('privacy') || text.includes('Lower exposure'),
      distanceMiles: distanceMatch ? Number(distanceMatch[1]) : null,
      durationMinutes: durationMatch ? Number(durationMatch[1]) : null,
      exposure: exposureMatch ? Number(exposureMatch[1]) : null
    };
  }));
}

function matchResponseRoute(card, responseRoutes) {
  if (!card || !responseRoutes.length) return null;
  return responseRoutes.find(route =>
    displayMiles(route.distance) === card.distanceMiles &&
    roundMinutes(route.duration) === card.durationMinutes
  ) || null;
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

async function runBrowserCase(browser, testCase, experimental) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.setDefaultTimeout(MAX_WAIT_MS);
  const page = await context.newPage();
  await page.setExtraHTTPHeaders({ 'Cache-Control': 'no-cache' });

  let routeIntercepted = false;
  const routeResponses = [];
  const routeResponseTasks = [];
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
    if (url.origin !== 'https://api.mapbox.com' || !url.pathname.startsWith(MAPBOX_DIRECTIONS_PATH)) return;
    if (url.searchParams.get('alternatives') === 'true') directionsRequests.initial += 1;
    if (url.searchParams.get('alternatives') === 'false') directionsRequests.generated += 1;
  });

  page.on('response', async response => {
    const url = new URL(response.url());
    if (url.origin !== 'https://api.mapbox.com' || !url.pathname.startsWith(MAPBOX_DIRECTIONS_PATH) || !response.ok()) return;
    routeResponseTasks.push(response.json().then(body => {
      if (body?.routes?.length) routeResponses.push(...body.routes);
    }).catch(() => {}));
  });

  if (experimental) {
    const source = readExperimentalRouteSource();
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
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
  }

  try {
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
    await page.waitForFunction(() => {
      const message = document.querySelector('[data-route-message]')?.textContent || '';
      return message.includes('Lowest found exposure') || message.includes('No lower-exposure route') || message.includes('could not be loaded') || message.includes('failed');
    });

    await Promise.all(routeResponseTasks);
    const cards = await parseRouteCards(await page.locator('[data-route-results] .route-result').all());
    if (!cards.length) throw new Error(`${testCase.name}: no user-facing route results rendered`);
    const fastestCard = cards.find(card => card.fastest) || cards[0];
    const privacyCard = cards.find(card => card.privacy) || null;
    const fastestRoute = matchResponseRoute(fastestCard, routeResponses);
    const privacyRoute = matchResponseRoute(privacyCard, routeResponses);
    if (!fastestRoute) throw new Error(`${testCase.name}: fastest route could not be matched to a Directions response`);
    if (privacyCard && !privacyRoute) throw new Error(`${testCase.name}: privacy route could not be matched to a Directions response`);

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
      }
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
      results.push(await runBrowserCase(browser, testCase, false));
      results.push(await runBrowserCase(browser, testCase, true));
    }
    process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});