# Security tests — Route & Stop

Service owner: Yahia Wael (247330), Team 14.

> **Nothing in the Actual or Result columns has been filled in yet.** These
> tests have not been run. Run them against the Floci deployment, paste what
> really comes back, and save the evidence files named below. Do not copy the
> expected value into the actual column: a test that was never run is worth
> less than a test that failed, because a failure can be fixed.

## Before running

```bash
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1
bash infra/deploy.sh                      # prints the API address
export API=http://<api-id>.execute-api.localhost.floci.io:4566

node scripts/make-test-sessions.js        # writes .test-tokens.local
source .test-tokens.local                 # ADMIN_TOKEN, PARENT1_TOKEN, ...
mkdir -p docs/evidence
```

`.test-tokens.local` is ignored by git. Never paste a real token into this
file or into a screenshot.

---

## The tests

| # | What it checks | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|
| S1 | No token on a protected route | 401 `UNAUTHENTICATED` | | | `s1-no-token.txt` |
| S2 | A parent on an admin route | 403 `FORBIDDEN` | | | `s2-parent-forbidden.txt` |
| S3 | An invented token | 401, same message as S1 | | | `s3-bad-token.txt` |
| S4 | Invalid input | 400 `VALIDATION_ERROR` | | | `s4-validation.txt` |
| S5 | Wrong content type | 415 `UNSUPPORTED_MEDIA_TYPE` | | | `s5-content-type.txt` |
| S6 | Client tries to set a server field | 400, "set by the server" | | | `s6-server-fields.txt` |
| S7 | Rate limit | 429 with `Retry-After` | | | `s7-rate-limit.txt` |
| S8 | Security headers present | 6 headers | | | `s8-headers.txt` |
| S9 | Internal endpoint without the key | 401 | | | `s9-internal-key.txt` |
| S10 | No secret in the deployed function | only SECRET_ID, CORS_ORIGINS, NODE_ENV | | | `s10-secret-review.txt` |

---

### S1 — no token

```bash
curl -s -i "$API/api/routes" | tee docs/evidence/s1-no-token.txt | head -20
```

Expect `HTTP/1.1 401` and `{"error":{"code":"UNAUTHENTICATED",...}}`. This is
the one that matters most: if a route list comes back, every endpoint behind
it is open.

### S2 — a parent on an admin route

```bash
curl -s -i -X POST "$API/api/routes" \
  -H "Authorization: Bearer $PARENT1_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"code":"R-99","name":"Parent Should Not Create This","area":"Maadi"}' \
  | tee docs/evidence/s2-parent-forbidden.txt | head -20
```

Expect `403`. A logged-in parent is authenticated but not authorised; the
two are separate checks in `middleware/auth.js` for exactly this case.

### S3 — an invented token

```bash
curl -s -i "$API/api/routes" \
  -H "Authorization: Bearer this-token-was-never-issued-aaaaaaaaaaaa" \
  | tee docs/evidence/s3-bad-token.txt | head -20
```

Expect `401` with **the same message as an expired session**. A different
message would tell an attacker which tokens once existed.

### S4 — invalid input

```bash
curl -s -i -X POST "$API/api/trips" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"route_id":"not-a-uuid","service_date":"2026-02-31","run_type":"evening"}' \
  | tee docs/evidence/s4-validation.txt | head -20
```

Expect `400`. Three separate problems here: an id that is not a uuid, a date
that matches the pattern but is not a real day, and a run type outside the
allowed set. The API answers with the first one.

### S5 — wrong content type

```bash
curl -s -i -X POST "$API/api/routes" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: text/plain' \
  -d 'code=R-98' \
  | tee docs/evidence/s5-content-type.txt | head -20
```

Expect `415`.

### S6 — the client tries to choose a server field

```bash
curl -s -i -X POST "$API/api/routes" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"HACKED-1","code":"R-97","name":"Injected Line","area":"Maadi"}' \
  | tee docs/evidence/s6-server-fields.txt | head -20
```

Expect `400`, "set by the server". Refusing is better than ignoring: an
attempt shows up in the log instead of disappearing.

### S7 — rate limit

```bash
for i in $(seq 1 130); do
  curl -s -o /dev/null -w "%{http_code} " "$API/api/routes" \
    -H "Authorization: Bearer $PARENT1_TOKEN"
done | tee docs/evidence/s7-rate-limit.txt
echo
curl -s -i "$API/api/routes" -H "Authorization: Bearer $PARENT1_TOKEN" | grep -i 'ratelimit\|retry-after'
```

Expect a run of `200` then `429`, and a `Retry-After` header. The read
budget is 120 a minute.

Note which limiter fired. Without Upstash configured the counter is in
memory and therefore **per Lambda container**, so the cut-off may come later
than 120 or not at all if Floci started more than one container. Say which
it was; that is the honest result and it is also the argument for Upstash.

### S8 — security headers

```bash
curl -s -I "$API/api/health" | tee docs/evidence/s8-headers.txt
```

Expect all six: `Content-Security-Policy`, `X-Content-Type-Options`,
`X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`,
`Cross-Origin-Resource-Policy`. `X-Powered-By` must be **absent** — a version
banner only helps someone looking for a framework with a known CVE.

### S9 — internal endpoint without the key

```bash
curl -s -i "$API/api/internal/events" | tee docs/evidence/s9-internal-key.txt | head -20
curl -s -i "$API/api/internal/events" -H 'X-Internal-Key: wrong-key-here' | head -5
```

Expect `401` both times. The key is compared with `timingSafeEqual`, so a
wrong guess takes the same time as any other and leaks nothing byte by byte.

### S10 — no secret on the function

```bash
aws lambda get-function-configuration --function-name route-stop-api \
  --query 'Environment.Variables' | tee docs/evidence/s10-secret-review.txt
```

Expect exactly `SECRET_ID`, `CORS_ORIGINS`, `NODE_ENV`. If `DATABASE_URL`
appears here, the deployment is wrong: anyone who can read the function's
configuration can then read the database.

Also confirm nothing secret is in the repository or the zip:

```bash
git ls-files | grep -iE '\.env$|token|secret' || echo "clean"
npm run zip && unzip -l dist/route-stop-api.zip | grep -i env || echo "no .env in the zip"
```

---

## What the SECURITY log should show afterwards

Every refusal above writes one line with `"event":"SECURITY"`.

```bash
aws logs tail /aws/lambda/route-stop-api --since 15m --format short | grep SECURITY
```

Expect `auth_missing_token`, `auth_invalid_session`, `authz_role_refused`,
`rate_limited`, `internal_key_refused`. No line should contain a token, an
`Authorization` header, a body or a connection string — check that too, and
say so here.

`infra/deploy.sh` puts a CloudWatch metric filter on these lines and an alarm
above 20 in five minutes, so a flood becomes a number on a graph rather than
a line nobody reads. Floci may accept the filter without enforcing it; note
which happened.

---

## Summary

Fill in after running.

- Tests passed: __ of 10
- Anything that failed, and what was changed:
- Anything not testable on Floci, and why:
