# Finish notes: Route & Stop service

Written by Ali for Yehia, 27 Nov 2026. Read this before the discussion. Everything below
was run on Floci on Ali's laptop, with Ali's Favorites & Alerts service and Ahmed's
backend on the same Floci.

## 1. What was missing, and what was done

| Was missing | Now |
|---|---|
| `package-lock.json` out of sync, `npm ci` failed | Fixed. A fresh clone runs `npm ci` and `npm test` cleanly |
| No `evidence/` folder | Deploy output, CLI evidence and images, 11 security tests, the joint test, k6, 4 screenshots |
| `docs/security-tests.md` only pointed to the plan | Full table with real results |
| `docs/load-test.md` had an empty table | Real k6 numbers and notes |

## 2. Bugs found while deploying (all fixed in this folder)

These did not show up in Jest, because Jest uses a fake DynamoDB and never runs on Lambda.

1. **Users table key.** `middleware/auth.js` read `Users` with `{ user_id }`. The team `Users`
   table (Ahmed's) is keyed by `id`. On the shared Floci every logged-in request would fail.
   Now it reads `{ id }`. Same fix in `services/routes.js` (supervisor check),
   `scripts/make-test-sessions.js`, `infra/deploy.sh`, the fake DynamoDB and the tests.
2. **serverless-http was not in package.json.** `lambda.js` needs it, so the Lambda could not
   start (500 on every call). Added.
3. **The Lambda zip left out package files.** `scripts/zip.js` skipped every `dist/` and `test/`
   folder at every depth, also inside `node_modules`. `content-type` loads `dist/index.js`, so the
   function crashed. Now the folder rules apply only to the project, not inside packages.
4. **deploy.sh on Windows.** It wrote the IAM policy files to `/tmp`, which the Windows `aws`
   program cannot read. Now they go in `dist/` (git ignores it) with a relative path.
   Also, an empty `SECRET_ID=` broke the `--environment` value, so `SECRET_ID` is only added
   when it is set.
5. **JSON bodies on Lambda.** `lambda.js` turned the Buffer body into a string but never parsed
   it, so every POST, PUT and PATCH answered 400 "Request body must be a JSON object."
   (cancel trip, create route, everything). Now it parses JSON there. Bad JSON still gives 400.
6. **The SECURITY alarm could never fire.** The metric filter was the JSON filter
   `{ $.event = "SECURITY" }`, but a Lambda log line starts with the time, the request id and
   the level, so it is not pure JSON. Now the filter is the text `SECURITY`.

## 3. Tests

- Unit tests (`node --test`): **61 of 61 pass.**
- API tests (Jest): **29 of 29 pass.**
- Both also pass from a fresh clone after `npm ci`.

## 4. Security tests (on Floci, against the deployed API)

Details: `docs/security-tests.md` and `evidence/ST-01.txt` to `ST-11.txt`.

| ID | Test | Result |
|---|---|---|
| ST-01 | No token, 401 | Pass |
| ST-02 | Fake token, 401 | Pass |
| ST-03 | Expired session, 401 with the same message | Pass |
| ST-04 | Parent on admin routes, 403 | Pass |
| ST-05 | NoSQL injection in an id, 400 | Pass |
| ST-06 | Wrong content type, 415 | Pass |
| ST-07 | Rate limit 429 with Retry-After, fake X-Forwarded-For | Partial pass |
| ST-08 | Security headers | Pass |
| ST-09 | No secrets in Lambda env, git, logs | Partial fail |
| ST-10 | Internal endpoint, wrong key, 401 | Pass |
| ST-11 | SECURITY lines and the alarm | Pass after fix (bug 6) |

**ST-07:** the 429 and `Retry-After` work, and a fake `X-Forwarded-For` does not help (the count
is per user). But the count is in memory per Lambda copy, so on Floci the first 130 requests
got no 429. Floci does not enforce the API Gateway throttle either.

**ST-09 (still open):** `INTERNAL_API_KEY` is a plain value in the Lambda environment and in the
EventBridge target input. The fix: store it in Secrets Manager. `config/secrets.js` already loads
it from the secret in `SECRET_ID`, so only `infra/deploy.sh` has to change. Be ready to explain this.

## 5. Joint cancel test (your service and Ali's)

`evidence/joint-cancel-test.txt` and `evidence/joint-cancel-alert.png`. **Pass.**

1. parent1 saved stop "Road 9 Corner" on your route `route-demo-maadi` through Ali's API.
2. admin cancelled today's afternoon trip through your API: 200, one `trip.cancelled` event, sent.
3. Ali's Lambda read 1 message from `favorites-alerts-queue` and made 1 alert.
4. parent1 sees "Route R1: the afternoon trip on 2026-11-27 is cancelled" on Ali's Alerts page.
5. A second cancel through your API: 409 "already cancelled", so no second event.
   The same `event_id` sent to the queue again: Ali's service skipped it, 0 new alerts.

The first try failed at step 2 because of bug 5. After the fix the whole test was run again.

## 6. k6 (your script, not changed)

`docs/load-test.md` and `evidence/k6-routes.txt`.

| | Result |
|---|---|
| p95 | 6.44 s (threshold 500 ms, not passed) |
| median | 24.62 ms |
| failed rate | 28.31% (threshold 5%, not passed) |
| 429s | 919 of 3245 |
| requests | 3246, 18.98 per second |

All 100 users used one token, so the per-user limit sent 429s. Those 429s are the whole
failed rate: there were no 5xx. Your script's comment says a 429 is not a failure, but k6 still
counts it, because the script has no `responseCallback`. The slow p95 is Floci starting Lambda
copies on one laptop during the spike.

## 7. Frontend screenshots

`evidence/frontend-routes-parent.png` (route details with the cancelled run),
`evidence/frontend-routes-admin.png` (admin tabs and route list),
`evidence/frontend-routes-error.png` (your API stopped: reserved concurrency 0, the gateway
answered 503, the page shows "Failed to fetch"). No frontend file was changed.

## 8. Questions you may get

- **Why does Jest pass when Lambda failed?** Jest uses a fake DynamoDB and calls Express
  directly. It never runs `lambda.js`, the zip or the real table keys. That is why the deploy
  and the Floci tests matter.
- **Why is a 429 not a failure?** It is the limit doing its job. In k6 you can mark it as
  expected with `http.setResponseCallback(http.expectedStatuses(200, 429))`.
- **Why is the rate limit weak on Floci?** In-memory count per Lambda copy, and Floci does not
  enforce API Gateway throttling.
- **What is still open?** ST-09: move `INTERNAL_API_KEY` to Secrets Manager.
