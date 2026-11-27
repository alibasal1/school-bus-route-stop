# Test plan — Route & Stop

Service owner: Yahia Wael (247330), Team 14.

Three layers, because they catch different things.

| Layer | Command | Needs Floci | Status |
|---|---|---|---|
| Unit (logic) | `npm run test:unit` | no | **50 pass** |
| API (Jest + Supertest) | `npm run test:api` | no | written, **not yet run** |
| Security on Floci (ST-01…ST-10) | by hand, below | yes | **not yet run** |
| Load (k6) | `k6 run loadtest/route-stop.js` | yes | **not yet run** |

> The API, security and load rows have not been run. They were written in an
> environment with no Docker and no network, so Floci, `npm install`, Jest
> and k6 were all unreachable. Nothing below has a result filled in that was
> not measured. Run them, paste what really comes back, and keep the files
> named in the Evidence column.

---

## 1. Unit tests — `npm run test:unit` (50 pass)

No database, no server: pure functions only, so the awkward cases are
reachable at all.

| What it proves |
|---|
| Weekend and holiday days are skipped, and the reason is reported |
| Running generation twice creates nothing the second time |
| Two routes sharing one bus do not both get the same slot |
| A leap day is a normal service day |
| A reorder returns only the stops that move; a partial or duplicated list is refused |
| Deleting a middle stop closes the gap |
| `2026-02-31` is rejected even though it matches the date pattern |
| Ids accept `route-cairo-demo`, reject `' OR 1=1`, `{"$ne": null}`, `../../etc/passwd` |
| A non-string id is rejected, which is how NoSQL injection usually arrives |
| Server-owned fields in a body are refused, not ignored |

## 2. API tests — `npm run test:api` (24 written)

Supertest drives the real Express app. Only DynamoDB (`tests/helpers/fakeDynamo.js`)
and the SQS client are replaced, so routes, guards, validation and the
service layer all run.

Notable: no token 401, expired session 401 with the same wording as unknown,
parent on an admin route 403, injection in an id 400, wrong content type
415, unknown path 404 with its own code, duplicate code 409, reorder
rewrites the sequence, a refused reorder changes nothing, deleting a middle
stop closes the gap, **cancelling sends exactly one SQS message in the
agreed shape**, and **cancelling twice is 409 and sends none**.

---

## 3. Security tests on Floci

### Before running

```bash
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1
bash infra/deploy.sh                 # prints the API address
export API=http://<api-id>.execute-api.localhost.floci.io:4566

npm run seed
node scripts/make-test-sessions.js   # writes .test-tokens.local
source .test-tokens.local
mkdir -p evidence
```

`.test-tokens.local` is ignored by git. Never paste a real token into this
file or a screenshot.

### The tests

| ID | What it checks | Expected | Actual | Pass | Evidence |
|---|---|---|---|---|---|
| ST-01 | No token | 401 `UNAUTHENTICATED` | | | `evidence/ST-01.txt` |
| ST-02 | Fake token | 401, same message as ST-01 | | | `evidence/ST-02.txt` |
| ST-03 | Parent on an admin route | 403 `FORBIDDEN` | | | `evidence/ST-03.txt` |
| ST-04 | NoSQL injection in an id | 400 `VALIDATION_ERROR` | | | `evidence/ST-04.txt` |
| ST-05 | Wrong content type | 415 | | | `evidence/ST-05.txt` |
| ST-06 | Rate limit | 429 with `Retry-After` | | | `evidence/ST-06.txt` |
| ST-07 | IAM has no `"*"` | four scoped statements | | | `evidence/ST-07.txt` |
| ST-08 | No secrets in env, git or logs | nothing found | | | `evidence/ST-08.txt` |
| ST-09 | Cancel reaches Ali's queue | alert on his page | | | `evidence/joint-cancel-test.txt` |
| ST-10 | Security headers | six present, no `X-Powered-By` | | | `evidence/ST-10.txt` |

### ST-01 no token
```bash
curl -s -i "$API/api/routes" | tee evidence/ST-01.txt | head -20
```

### ST-02 fake token
```bash
curl -s -i "$API/api/routes" \
  -H "Authorization: Bearer this-token-was-never-issued-aaaaaaaa" \
  | tee evidence/ST-02.txt | head -20
```
The message must be identical to ST-01. A different one would tell an
attacker which stolen tokens were once real.

### ST-03 parent on an admin route
```bash
curl -s -i -X POST "$API/api/routes" \
  -H "Authorization: Bearer $PARENT1_TOKEN" -H 'Content-Type: application/json' \
  -d '{"code":"R99","name":"Parent Should Not Create This","area":"Maadi"}' \
  | tee evidence/ST-03.txt | head -20
```

### ST-04 NoSQL injection in an id
```bash
{
  curl -s -i -X POST "$API/api/trips" \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
    -d '{"route_id":{"$ne":null},"run_type":"morning"}'
  curl -s -i "$API/api/routes/1%27%20OR%20%271%27=%271" \
    -H "Authorization: Bearer $ADMIN_TOKEN"
} | tee evidence/ST-04.txt | head -40
```
Both 400. The object form matters most: that is how NoSQL injection
actually arrives, and it is why `lib/validate.js` checks the type before the
pattern.

### ST-05 wrong content type
```bash
curl -s -i -X POST "$API/api/routes" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: text/plain' \
  -d 'code=R98' | tee evidence/ST-05.txt | head -20
```

### ST-06 rate limit
```bash
for i in $(seq 1 130); do
  curl -s -o /dev/null -w "%{http_code} " "$API/api/routes" \
    -H "Authorization: Bearer $PARENT1_TOKEN"
done | tee evidence/ST-06.txt
echo
curl -s -i "$API/api/routes" -H "Authorization: Bearer $PARENT1_TOKEN" \
  | grep -i 'ratelimit\|retry-after' | tee -a evidence/ST-06.txt
```
Expect a run of 200 then 429. The read budget is 120 a minute. Note which
limiter fired: the counter is in memory, so it is per Lambda container, and
if Floci starts more than one the cut-off moves. Say what really happened.

### ST-07 IAM least privilege
```bash
aws iam get-role-policy --role-name route-stop-api-role \
  --policy-name route-stop-api-policy | tee evidence/ST-07.txt
grep -c '"\*"' evidence/ST-07.txt   # expect 0
```
Check all four statements: write on own tables, **read only** on Users and
Sessions, `sqs:SendMessage` on one queue ARN, logs on one log group.

### ST-08 no secrets anywhere
```bash
{
  echo "--- git ---"
  git grep -nIE "(AKIA|aws_secret|BEGIN .*PRIVATE KEY|postgres://|password=)" || echo "clean"
  git ls-files | grep -iE '\.env$|token' || echo "no secret files tracked"
  echo "--- lambda env ---"
  aws lambda get-function-configuration --function-name route-stop-api \
    --query 'Environment.Variables'
  echo "--- logs ---"
  aws logs tail /aws/lambda/route-stop-api --since 30m --format short \
    | grep -iE "bearer |authorization|token=" || echo "no tokens in logs"
} | tee evidence/ST-08.txt
```
`INTERNAL_API_KEY` does appear in the Lambda environment. Say so rather than
hiding it, and say why: Floci has no Secrets Manager requirement in this
build, and `infra/deploy.sh` moves it into Secrets Manager as soon as a
Turnstile key is configured.

### ST-09 joint test with Ali
1. Ali runs his `deploy.sh` so the queue and his consumer exist.
2. Parent 1 saves a stop on route `route-demo-maadi` in his My stops page.
3. Log in as admin and cancel that route's morning trip:
```bash
curl -s -i -X PATCH "$API/api/trips/trip:route-demo-maadi:morning/status" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"cancelled","reason":"Joint test","date":"'"$(date +%F)"'"}' \
  | tee evidence/joint-cancel-test.txt
```
4. Ali checks his log for the alerts line, and the alert appears on his
   Alerts page for that parent.
5. Send the same event twice and confirm **one** alert: he skips repeats by
   `event_id`.
6. Save his log output and a screenshot alongside.

### ST-10 security headers
```bash
curl -s -I "$API/api/health" | tee evidence/ST-10.txt
```
Expect `Content-Security-Policy`, `X-Content-Type-Options`,
`X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`,
`Cross-Origin-Resource-Policy`, and **no** `X-Powered-By`.

### The SECURITY log afterwards
```bash
aws logs tail /aws/lambda/route-stop-api --since 20m --format short | grep SECURITY
```
Expect `auth_missing_token`, `auth_invalid_session`, `authz_role_refused`,
`rate_limited`, and `turnstile_skipped`. The metric filter and alarm created
by `infra/deploy.sh` count these.

---

## 4. Load test — k6

```bash
export API_URL="$API" PARENT_TOKEN="$PARENT1_TOKEN"
k6 run loadtest/route-stop.js | tee evidence/k6-routes.txt
```

Lab 8 stages: 20 users, spike to 100. Thresholds p95 < 500 ms and failures
under 5%.

| Metric | Threshold | Measured | Pass |
|---|---|---|---|
| `http_req_duration` p95 | < 500 ms | | |
| `http_req_failed` | < 5% | | |
| 429s seen | — | | |

Write the real numbers in `docs/load-test.md`, including a p95 over 500 ms.
On Floci the whole stack is Docker on one laptop and a cold Lambda start is
slow; that is a fair explanation and it is testable by comparing the first
requests with the later ones. A number nobody measured is worth less than an
honest failure.
