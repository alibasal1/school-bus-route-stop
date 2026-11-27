#!/usr/bin/env node
// Seed demo data into DynamoDB on Floci.
//
//   npm run seed
//
// Two routes with three stops each, a bus for each, a schedule, and today's
// trips. Everything it writes carries demo: true, so cleanup-test-data.js
// can remove exactly what this put there and nothing else.
//
// Safe to run again: the ids are fixed, so a second run overwrites the same
// items instead of making duplicates.

require('dotenv').config({ quiet: true });

const { TABLES, putItem } = require('../db/dynamo');

const nowIso = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

const ROUTES = [
  { id: 'route-demo-maadi', code: 'R1', name: 'Maadi Morning Line', area: 'Maadi' },
  { id: 'route-demo-nasr', code: 'R2', name: 'Nasr City Line', area: 'Nasr City' },
];

const STOPS = [
  { id: 'stop-demo-maadi-1', route_id: 'route-demo-maadi', name: 'Road 9 Corner', landmark: 'Next to the pharmacy', stop_order: 1, lat: 29.9602, lng: 31.2569 },
  { id: 'stop-demo-maadi-2', route_id: 'route-demo-maadi', name: 'Maadi Club Gate', landmark: 'Main gate', stop_order: 2, lat: 29.9571, lng: 31.2498 },
  { id: 'stop-demo-maadi-3', route_id: 'route-demo-maadi', name: 'School Gate B', landmark: null, stop_order: 3, lat: 29.9745, lng: 31.2601 },
  { id: 'stop-demo-nasr-1', route_id: 'route-demo-nasr', name: 'Abbas El Akkad', landmark: 'Opposite the bank', stop_order: 1, lat: 30.0588, lng: 31.3401 },
  { id: 'stop-demo-nasr-2', route_id: 'route-demo-nasr', name: 'Makram Ebeid', landmark: null, stop_order: 2, lat: 30.0612, lng: 31.3352 },
  { id: 'stop-demo-nasr-3', route_id: 'route-demo-nasr', name: 'School Gate B', landmark: null, stop_order: 3, lat: 29.9745, lng: 31.2601 },
];

const BUSES = [
  { id: 'bus-demo-1', plate_number: 'DEMO 101', capacity: 40, route_id: 'route-demo-maadi' },
  { id: 'bus-demo-2', plate_number: 'DEMO 202', capacity: 36, route_id: 'route-demo-nasr' },
];

// Sunday to Thursday, the normal Egyptian school week, in the ISO numbering
// the API uses (1 = Monday ... 7 = Sunday).
const SCHOOL_WEEK = [7, 1, 2, 3, 4];

async function main() {
  console.log(`Seeding demo data (endpoint: ${process.env.AWS_ENDPOINT_URL || 'real AWS'})`);

  for (const route of ROUTES) {
    await putItem(TABLES.ROUTES, {
      ...route,
      is_active: true,
      demo: true,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
  }
  console.log(`  ${ROUTES.length} routes`);

  for (const stop of STOPS) {
    await putItem(TABLES.STOPS, { ...stop, demo: true, created_at: nowIso() });
  }
  console.log(`  ${STOPS.length} stops`);

  for (const bus of BUSES) {
    await putItem(TABLES.BUSES, { ...bus, demo: true, created_at: nowIso() });
  }
  console.log(`  ${BUSES.length} buses`);

  for (const route of ROUTES) {
    for (const runType of ['morning', 'afternoon']) {
      await putItem(TABLES.SCHEDULES, {
        id: `sched:${route.id}:${runType}`,
        route_id: route.id,
        run_type: runType,
        days_of_week: SCHOOL_WEEK,
        bus_id: BUSES.find((bus) => bus.route_id === route.id)?.id ?? null,
        active_from: today(),
        active_to: null,
        demo: true,
        updated_at: nowIso(),
      });
    }
  }
  console.log(`  ${ROUTES.length * 2} schedules`);

  // Trips use Ahmed's design: one per route per run type, with
  // cancelled_date set only when a single day is called off.
  let trips = 0;
  for (const route of ROUTES) {
    for (const runType of ['morning', 'afternoon']) {
      await putItem(TABLES.TRIPS, {
        id: `trip:${route.id}:${runType}`,
        route_id: route.id,
        bus_id: BUSES.find((bus) => bus.route_id === route.id)?.id ?? null,
        run_type: runType,
        status: 'active',
        cancelled_date: null,
        source: 'seed',
        demo: true,
        created_at: nowIso(),
      });
      trips += 1;
    }
  }
  console.log(`  ${trips} trips`);

  console.log('\nDone. Try:  curl $API/api/routes -H "Authorization: Bearer <token>"');
}

main().catch((error) => {
  // The message only. A client error can carry an endpoint or a credential.
  console.error('Seeding failed:', error.message);
  process.exit(1);
});
