# Load test — Route & Stop

Service owner: Yahia Wael (247330), Team 14.

> **No numbers here have been measured yet.** The table below is empty on
> purpose. Run k6, paste what it actually prints, and keep the output file.
> An honest p95 of 1,400 ms with a reason is worth more than a 480 ms that
> nobody measured, and the reason is usually interesting in itself.

## How to run it

```bash
export API_URL=http://<api-id>.execute-api.localhost.floci.io:4566
source .test-tokens.local
export PARENT_TOKEN="$PARENT1_TOKEN"

k6 run loadtest/route-stop.js | tee docs/evidence/k6-route-stop.txt
```

## The shape of the test (Lab 8)

| Stage | Duration | Virtual users |
|---|---|---|
| ramp up | 30s | 0 → 20 |
| hold | 1m | 20 |
| **spike** | 30s | 20 → 100 |
| recover | 30s | 100 → 20 |
| ramp down | 20s | 20 → 0 |

Reads only: `GET /api/routes?search=maadi` and `GET /api/trips`. These are
the two endpoints a parent actually repeats. Writes are left out because a
write test would leave hundreds of rows behind and would mostly be measuring
the write rate limit.

Thresholds: **p95 < 500 ms** and **failed rate < 0.05**.

## Results

| Metric | Threshold | Measured | Pass? |
|---|---|---|---|
| `http_req_duration` p95 | < 500 ms | | |
| `http_req_duration` median | — | | |
| `http_req_duration` max | — | | |
| `http_req_failed` | < 5% | | |
| `rate_limited` | — | | |
| Requests completed | — | | |
| Throughput (req/s) | — | | |

Date run:
Machine:

## What to write under the table

Answer these in a sentence or two each, from what the run shows.

1. **Did p95 pass?** If not, say by how much and what the likely cause was.
   On Floci the whole stack is Docker on one laptop, and a cold Lambda start
   includes fetching the secret and opening a Neon connection over the
   internet. That is a fair explanation, and it is testable: compare the
   first requests with the later ones.

2. **How many 429s, and from which limiter?** At 100 virtual users some are
   expected and are not failures — that is the rate limiter working. Note
   whether the in-memory counter or Upstash was in use, because the
   in-memory one is per container and so the cut-off moves around.

3. **Did anything 500?** Any 5xx is a real defect, not load. Find the
   request id in the CloudWatch log and say what it was.

4. **Where did the time go?** `http_req_waiting` is the server; the rest is
   connection setup. If waiting dominates, the database queries are the
   place to look; the route search joins `stops` and counts per route.

5. **What would you change?** Honest options, not a wish list: the search
   endpoint already sets `Cache-Control`, Upstash would make the limit real,
   and the stop count could be stored on the route rather than counted on
   every search.

## Evidence

- `docs/evidence/k6-route-stop.txt` — the full k6 output
- A screenshot of the summary, if the report asks for one
