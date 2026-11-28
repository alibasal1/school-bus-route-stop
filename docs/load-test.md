# Load test: Route & Stop

Service owner: Yahia Wael (247330), Team 14.

## How it was run

```bash
export API_URL=http://<api-id>.execute-api.localhost.floci.io:4566
export PARENT_TOKEN=<parent1 token, from scripts/make-test-sessions.js>   # never in a file
k6 run loadtest/route-stop.js
```

The script was not changed. Same stages and thresholds as written.

| Stage | Duration | Virtual users |
|---|---|---|
| ramp up | 30s | 0 to 20 |
| hold | 1m | 20 |
| spike | 30s | 20 to 100 |
| recover | 30s | 100 to 20 |
| ramp down | 20s | 20 to 0 |

Each iteration: `GET /api/routes?search=maadi&limit=10`, wait 0.5 s, `GET /api/trips?limit=20`, wait 1 s.
All virtual users use the same parent1 token.

Thresholds: **p95 < 500 ms** and **failed rate < 5%**.

## Results

Run on 27 Nov 2026, about 05:18 to 05:21 UTC, against
`http://b92afbc138.execute-api.localhost.floci.io:4566` (Lambda behind API Gateway on Floci).
Machine: one Windows laptop running k6, Docker, Floci and every Lambda copy.
Warm-up first: 60 s wait, then 3 x `GET /api/health` (200, about 50 ms).
Full output: `evidence/k6-routes.txt`.

| Metric | Threshold | Measured | Pass? |
|---|---|---|---|
| `http_req_duration` p95 | < 500 ms | 6.44 s | **No** |
| `http_req_duration` median | | 24.62 ms | |
| `http_req_duration` p90 | | 1.55 s | |
| `http_req_duration` max | | 38.82 s | |
| `http_req_failed` | < 5% | 28.31% (919 of 3246) | **No** |
| `rate_limited` (429) | | 919 of 3245 (28.32%) | |
| Checks (200 or 429, items present) | | 4869 of 4869 (100%) | |
| Requests | | 3246 | |
| Request rate | | 18.98 per second | |
| Iterations | | 1621 complete, 4 cut off at the end | |

## Notes

1. **p95 did not pass.** It is 6.44 s, about 13 times the limit, while the median is 25 ms.
   Most requests are fast. The slow ones are the requests that wait while Floci starts new
   Lambda copies as Docker containers during the spike to 100 users (max 38.82 s). Everything
   runs on one laptop, so this measures the laptop more than the code.
2. **The failed rate is the 429s, not errors.** 919 failed requests and 919 rate-limited
   answers: the same requests. All 100 users share one parent token, and the read limit is 120
   a minute per user, so 429s are expected. The script's comment says a 429 is not a failure,
   but the script does not tell k6 that (no `responseCallback`), so k6 counts it. The threshold
   was not changed.
3. **No 5xx.** Every answer was 200 or 429 (the "answered" checks are 100%).
4. **The limiter is the in-memory one** (no Upstash), so each Lambda copy has its own count.
   That is why the 429 count moves between runs (see ST-07 in `docs/security-tests.md`).
5. **What would help:** a shared rate limit store, keeping Lambda copies warm before a spike,
   and storing the stop count on the route instead of counting it on every search.
