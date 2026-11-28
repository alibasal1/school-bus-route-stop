# Security tests

Run on Floci on 27 Nov 2026, against the deployed API
`http://b92afbc138.execute-api.localhost.floci.io:4566` (Lambda behind API Gateway).
Each test has its full commands and answers in `evidence/ST-xx.txt`. Tokens come from
sessions made by `scripts/make-test-sessions.js` and are never written in a file: the
evidence shows only the variable names (`$PARENT1_TOKEN`, `$ADMIN_TOKEN`).

The older plan with ST-01 to ST-10 is still in [api-test-plan.md](api-test-plan.md).

**Result: 8 pass, 1 pass after a fix (ST-11), 1 partial pass (ST-07), 1 partial fail (ST-09).**

| ID | What | Request | Expected | Real result | Pass or fail |
|---|---|---|---|---|---|
| ST-01 | No token | `GET /api/routes` with no `Authorization` | 401 | 401 `UNAUTHENTICATED` "Please log in." | Pass |
| ST-02 | Fake token | `GET /api/routes` with a made-up 64 character token | 401 | 401 `UNAUTHENTICATED` | Pass |
| ST-03 | Expired session | A `Sessions` item for parent1 with `expires_at` one hour ago | 401, same message as ST-02 | 401, message is the same as for the fake token | Pass |
| ST-04 | Parent on admin routes | Parent: `POST /api/routes`, `PATCH /api/trips/{id}/status` | 403 | 403 `FORBIDDEN` on both | Pass |
| ST-05 | NoSQL injection in an id | `GET /api/routes/{"$ne": null}`, `/api/routes/' OR 1=1`, `/api/trips/{"$gt":""}` | 400, no data | 400 `VALIDATION_ERROR` on all three, no data | Pass |
| ST-06 | Wrong content type | Admin `POST /api/routes` with `Content-Type: text/plain` | 415 | 415 `UNSUPPORTED_MEDIA_TYPE` | Pass |
| ST-07 | Rate limit, also with fake `X-Forwarded-For` | 130, then 400 `GET /api/routes` as parent2, a new fake `X-Forwarded-For` on each | 429 with `Retry-After` | First run: 130 x 200, no 429. Second run: 217 x 200, 183 x 429. A 429 has `Retry-After: 12`. The fake header did not help (count is per user) | Partial pass |
| ST-08 | Security headers | `GET /api/health`, `GET /api/routes` | CSP, nosniff, DENY, no `X-Powered-By` | All there, plus Referrer-Policy, Permissions-Policy, CORP and HSTS; no `X-Powered-By` | Pass |
| ST-09 | No secrets in Lambda env, git, logs | Env names, `git log -p --all` search, log group search | No secret anywhere | Git: none. Logs: no token. Lambda env: `INTERNAL_API_KEY` is a plain value | Partial fail |
| ST-10 | Internal endpoint, wrong key | `GET /api/internal/cron/generate` and `POST /api/internal/events/retry` with no key and a wrong key | 401 | 401 on all four | Pass |
| ST-11 | SECURITY lines and the alarm | 25 requests with no token | SECURITY lines, alarm goes to ALARM | First run: lines written, metric 0, alarm stayed OK. After the fix: metric 25, alarm OK to ALARM | Pass after fix |

## What failed and why

**ST-07, rate limit (partial pass).** `middleware/rateLimit.js` counts in memory when no
Upstash store is set, so each Lambda copy has its own count. Floci ran the requests on more
than one copy, so the first 130 requests never hit 120 on any copy. With more requests the
429 came, with `Retry-After`. The API Gateway throttle (10 rps, burst 20) is set, but Floci
does not enforce it. A shared counter is not one of our lab services, so this stays a known gap.

**ST-09, Lambda environment (partial fail).** `infra/deploy.sh` puts `INTERNAL_API_KEY` in the
Lambda environment and in the EventBridge target input. Anyone who can read the function
settings can read it. The fix is to store it in Secrets Manager: `config/secrets.js` already
loads `INTERNAL_API_KEY` from the secret named by `SECRET_ID`, so only the deploy script has to
change. Not changed yet.

**ST-11, alarm (fixed).** The metric filter was the JSON filter `{ $.event = "SECURITY" }`. On
Lambda each log line starts with the time, the request id and the level, so the line is not
pure JSON and the filter never matched. `infra/deploy.sh` now uses the text filter `SECURITY`.
After a redeploy the metric counted 25 and the alarm went to ALARM when the 300 second period ended.
