# Infrastructure for the Route & Stop service

Everything here is configuration for services that live outside the
repository. The application code does not change when these are added; each
one is switched on by setting environment variables.

```
infra/
├── aws/
│   ├── trust-policy.json              who may wear the forwarder's role
│   ├── event-forwarder-policy.json    what that role may do
│   └── event-forwarder/index.mjs      the Lambda that drains the outbox
└── README.md
```

---

## 1. Upstash Redis — distributed rate limiting

**Why:** a counter held in a Vercel function's memory is per-instance, and
the platform runs as many instances as it likes. "20 writes a minute" then
really means "20 per minute per instance", which anyone with a little
concurrency walks straight past. Redis gives all instances one counter.

**Set up:** create a free database at upstash.com, copy the REST URL and
token into `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` locally
and in Vercel. The service reaches it with `fetch` over its REST API, so
there is no npm package and nothing extra in the dependency tree.

**Without it:** the service still runs and falls back to an in-memory
counter. That is fine on a laptop and in the demo; it is logged as a warning
in production so the gap is never invisible.

---

## 2. Cloudflare Turnstile — bot protection on writes

**Why:** threat 1 in the proposal. A login stops anonymous bots but not a
script driving a real account, and the widget on the page stops nothing at
all, because a script can skip the page and call the API directly. The
protection is the server-side check in `middleware/turnstile.js`.

**Set up:** create a Turnstile widget for the frontend's hostname. The site
key is public and goes in the frontend; the secret key goes in
`TURNSTILE_SECRET_KEY` here and nowhere else. Cloudflare's always-passing
test secret for local work is `1x0000000000000000000000000000000AA`.

**Fails closed.** If Cloudflare cannot be reached the write is refused with
503, not allowed through. Failing open would hand an attacker the way around
the control: make the check time out, then write freely.

---

## 3. Vercel Cron — scheduled trip generation

**Why:** the point of `route_schedules` is that nobody creates trips by hand.
`vercel.json` runs `GET /api/internal/cron/generate?days=21` every Sunday at
02:00 UTC, so the timetable always reaches three weeks ahead.

**Set up:** add a `CRON_SECRET` environment variable in Vercel. The platform
sends it as `Authorization: Bearer …`, and `requireScheduler` compares it in
constant time. Without a secret the route refuses every call rather than
defaulting to open.

The same endpoint works from an EventBridge rule or a curl in the lab, using
`X-Internal-Key: $INTERNAL_API_KEY` instead:

```bash
curl -H "X-Internal-Key: $INTERNAL_API_KEY" \
  "https://school-bus-route-stop.vercel.app/api/internal/cron/generate?days=21"
```

---

## 4. AWS SNS + Lambda — the event forwarder

**Why:** so a cancellation can never be announced to nobody. The cancel
writes its event into `route_events` in the same transaction as the status
change; this Lambda publishes those events to an SNS topic on a schedule and
marks them published. The Favorites & Alerts service subscribes to the topic.
If it is down, the events wait; nothing is lost and nothing is duplicated
into the cancel request's critical path.

**Deploy (Floci or real AWS — the commands are identical, as in Lab 7):**

```bash
# 1. The topic consumers subscribe to
aws sns create-topic --name school-bus-route-events

# 2. The role and its permissions
aws iam create-role --role-name route-stop-forwarder-role \
  --assume-role-policy-document file://infra/aws/trust-policy.json

aws iam create-policy --policy-name route-stop-forwarder-access \
  --policy-document file://infra/aws/event-forwarder-policy.json

aws iam attach-role-policy --role-name route-stop-forwarder-role \
  --policy-arn arn:aws:iam::000000000000:policy/route-stop-forwarder-access

# 3. The function itself
cd infra/aws/event-forwarder && zip -r ../forwarder.zip index.mjs && cd -

aws lambda create-function --function-name route-stop-event-forwarder \
  --runtime nodejs20.x --handler index.handler \
  --role arn:aws:iam::000000000000:role/route-stop-forwarder-role \
  --zip-file fileb://infra/aws/forwarder.zip --timeout 30 \
  --environment "Variables={ROUTE_STOP_API_URL=https://school-bus-route-stop.vercel.app,\
INTERNAL_API_KEY=$INTERNAL_API_KEY,\
EVENTS_TOPIC_ARN=arn:aws:sns:us-east-1:000000000000:school-bus-route-events}"

# 4. Run it every five minutes
aws events put-rule --name route-stop-drain-outbox \
  --schedule-expression "rate(5 minutes)"

aws events put-targets --rule route-stop-drain-outbox \
  --targets "Id=1,Arn=arn:aws:lambda:us-east-1:000000000000:function:route-stop-event-forwarder"

aws lambda add-permission --function-name route-stop-event-forwarder \
  --statement-id events-invoke --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn arn:aws:events:us-east-1:000000000000:rule/route-stop-drain-outbox
```

### Least privilege in `event-forwarder-policy.json`

The role may publish to **one** topic and write **its own** log group. It
cannot read the database, touch another topic, create a topic, or delete
anything. If the function were compromised, that is the entire blast radius.
The `Resource` fields are specific ARNs rather than `"*"` for exactly that
reason — two of the four threats in the proposal are about what an attacker
can reach *after* getting in, and this is the answer to both.

Note the two kinds of permission involved, as in Lab 7: the **execution
role** above says what the function may do, while `lambda add-permission`
says who may invoke the function. Real AWS checks both; Floci stores them
without enforcing them, so a policy that is too narrow will pass on Floci and
fail with `AccessDeniedException` on a real account.

### Verifying it works

```bash
# Events waiting to go out
curl -H "X-Internal-Key: $INTERNAL_API_KEY" \
  https://school-bus-route-stop.vercel.app/api/internal/events

# Run the forwarder by hand
aws lambda invoke --function-name route-stop-event-forwarder out/forwarder.json
cat out/forwarder.json

# What it logged
aws logs tail /aws/lambda/route-stop-event-forwarder --since 10m --format short
```

---

## Environment variables, and where each one lives

| Variable | Local `.env` | Vercel | Lambda | Secret |
|---|---|---|---|---|
| `DATABASE_URL` | yes | yes | no | **yes** |
| `CORS_ORIGINS` | yes | yes | no | no |
| `INTERNAL_API_KEY` | yes | yes | yes | **yes** |
| `CRON_SECRET` | no | yes | no | **yes** |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | optional | yes | no | **yes** (token) |
| `TURNSTILE_SECRET_KEY` | optional | yes | no | **yes** |
| `ROUTE_STOP_API_URL` | no | no | yes | no |
| `EVENTS_TOPIC_ARN` | no | no | yes | no |

No secret is ever written in code, in `.env.example`, or in a commit.
`.gitignore` keeps `.env` out of the repository; the deployed copies live in
the Vercel dashboard and the Lambda configuration, both encrypted at rest.
