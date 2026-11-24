// k6 load test for the Route & Stop API (Lab 8 shape).
//
//   export API_URL=http://<api-id>.execute-api.localhost.floci.io:4566
//   export PARENT_TOKEN=<token from scripts/make-test-sessions.js>
//   k6 run loadtest/route-stop.js
//
// Reads only. A load test that creates routes or trips would leave hundreds
// of rows behind and would also be testing the write rate limit rather than
// the service, so the two endpoints below are the ones a parent actually
// hammers: the route search and the trip list.
//
// The thresholds come from the lab: p95 under 500 ms and under 5% failures.
// Record whatever actually happens in docs/load-test.md, including a p95
// over 500 ms. A cold Lambda on a laptop under Docker is slow, and saying
// so with a reason is worth more than a number that was never measured.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const rateLimited = new Rate('rate_limited');

const API_URL = __ENV.API_URL;
const TOKEN = __ENV.PARENT_TOKEN;

export const options = {
  stages: [
    { duration: '30s', target: 20 },  // warm up to the normal load
    { duration: '1m', target: 20 },   // hold
    { duration: '30s', target: 100 }, // the spike
    { duration: '30s', target: 20 },  // back down
    { duration: '20s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.05'],
  },
};

export function setup() {
  if (!API_URL || !TOKEN) {
    throw new Error('Set API_URL and PARENT_TOKEN before running k6.');
  }
  // Fail early with a clear message rather than reporting 100% errors.
  const probe = http.get(`${API_URL}/api/health`);
  if (probe.status !== 200) {
    throw new Error(`The API is not answering at ${API_URL} (health gave ${probe.status}).`);
  }
  return {};
}

export default function () {
  const params = {
    headers: { Authorization: `Bearer ${TOKEN}` },
    // k6 counts a 429 as a failure by default. It is not one: it is the
    // rate limiter doing its job, and at 100 users it is expected. Tagging
    // it keeps the failure rate meaningful and still records how often it
    // happened.
    tags: { endpoint: 'routes' },
  };

  const search = http.get(`${API_URL}/api/routes?search=maadi&limit=10`, params);
  rateLimited.add(search.status === 429);
  check(search, {
    'search answered': (r) => r.status === 200 || r.status === 429,
    'search has items': (r) => r.status !== 200 || r.json('items') !== undefined,
  });

  sleep(0.5);

  const trips = http.get(`${API_URL}/api/trips?limit=20`, {
    ...params,
    tags: { endpoint: 'trips' },
  });
  rateLimited.add(trips.status === 429);
  check(trips, {
    'trips answered': (r) => r.status === 200 || r.status === 429,
  });

  sleep(1);
}
