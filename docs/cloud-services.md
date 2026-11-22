# Cloud services used by this service, and why

Phase 1 feedback: *"your project is mirroring the labs without any
modification… you should switch or use more cloud services for security and
traffic reasons"*, and *"in threat modeling, there were little to no cloud
services implemented to solve some threats"*.

This page is the answer for the Route & Stop service. Each entry says what
the service is, which problem it solves, and what happens without it.
Setup commands are in [`../infra/README.md`](../infra/README.md); the
threats are in [`threat-model.md`](threat-model.md).

| Service | Category | Solves | From the labs? |
|---|---|---|---|
| Vercel Functions | compute | hosts the API | Lab 5 |
| Neon Postgres | data | stores the timetable | Lab 5 |
| **Upstash Redis** | **traffic** | shared rate-limit counters | new |
| **Cloudflare Turnstile** | **security** | bots on write endpoints | Lab 5 optional, not done there |
| **Vercel Cron** | **traffic / automation** | generates trips on a schedule | new |
| **AWS SNS** | **integration** | carries events to other services | new |
| **AWS Lambda + EventBridge** | **compute** | drains the outbox | Lab 7 ideas, new use |
| **AWS IAM** | **security** | least privilege for the forwarder | Lab 7 |
| **AWS CloudWatch Logs** | **operations** | forwarder logs and alarms | Lab 7 |

---

## 1. Upstash Redis — traffic

**Problem.** Neon's free plan allows 100 compute-hours a month. One scripted
loop against `GET /api/routes` exhausts that and the database pauses for
every family. Rate limiting is the control, but *where the counter lives*
decides whether it works at all.

**Why a cloud service and not just code.** A counter in a Vercel function's
memory is per-instance, and the platform starts as many instances as the
traffic needs. "20 writes a minute" then means "20 per minute per instance",
and anyone with a little concurrency walks straight past it. Upstash gives
every instance one counter.

**How.** `middleware/rateLimit.js` calls Upstash's REST API with `fetch` —
no npm package, so no extra supply-chain exposure for a single `INCR`.
Three budgets: reads 120/min, writes 20/min, generation 5 per 5 minutes.

**Without it.** Falls back to in-memory counting, logged as a warning in
production. Fine on a laptop, not a real control in the cloud.

**Trade-off.** Fails **open**: if Upstash is unreachable the request is
allowed and the gap is logged. A limiter that takes the API down when its
own store is down has become the outage it was meant to prevent.

---

## 2. Cloudflare Turnstile — security

**Problem.** Threat 1 in the proposal: automated clients spamming the write
endpoints. A login stops anonymous bots, but not a script driving a real
account.

**Why a cloud service.** Telling a browser apart from a script is exactly
the judgement we cannot make ourselves. Cloudflare sees traffic across
millions of sites; we see ours.

**How.** The widget produces a token in the browser; `app.js` sends it as
`X-Turnstile-Token`; `middleware/turnstile.js` verifies it **server-side**
with Cloudflare before the handler runs. The widget alone protects nothing —
a bot skips the page and calls the API directly. The server check is the
control. That is the Lab 3 trust boundary applied to bot defence.

**Trade-off.** Fails **closed**, unlike the rate limiter. Allowing
unverified writes whenever Cloudflare is slow would hand an attacker the
bypass: time the check out, then write freely.

---

## 3. Vercel Cron — traffic and automation

**Problem.** The whole point of `route_schedules` is that nobody creates
trips by hand. Something has to expand the pattern on a schedule.

**How.** `vercel.json` runs `GET /api/internal/cron/generate?days=21` every
Sunday at 02:00 UTC, so the timetable always reaches three weeks ahead.
Vercel signs the call with `CRON_SECRET`; `requireScheduler` compares it in
constant time and refuses everything if no secret is configured.

**Traffic angle.** Generating three weeks once, off-peak, instead of
hundreds of admin form submissions during the day, moves the write load off
the hours when parents are reading.

---

## 4. AWS SNS + Lambda + EventBridge — integration

**Problem.** When a trip is cancelled, parents must be told, and alerts
belong to Ali's service.

**Why not just call his API.** The obvious design is an HTTP call inside the
cancel request. It is wrong: the call sits outside the database transaction,
so if his service is slow or down, the trip is cancelled and the alert is
**lost**. The admin sees success; the parents wait at the kerb. It also
couples the two services — his downtime becomes our failed request.

**How.** The cancellation and a row in `route_events` are written in **one
transaction**: either both land or neither does. A Lambda on an EventBridge
schedule publishes unpublished rows to an SNS topic and marks them
published. If the consumer is down, events wait. Delivery is at-least-once,
so the event id is the consumer's idempotency key. A fourth consumer
subscribes to the topic and nothing in this service changes.

This is the transactional outbox pattern, and it is the one piece of
architecture here that the labs do not contain in any form.

---

## 5. AWS IAM — security

The forwarder's role may `sns:Publish` to **one** topic ARN and write **its
own** log group. No database, no other topic, no delete, no `"*"`. If the
function were compromised, that is the whole blast radius.

Two kinds of permission are involved, as Lab 7 sets out: the execution role
says what the function may do; `lambda add-permission` says who may invoke
it. Real AWS checks both. Floci stores them without enforcing them, so a
policy that is too narrow passes on Floci and fails with
`AccessDeniedException` on a real account — worth saying in the demo.

---

## 6. CloudWatch Logs — operations

The API logs one structured JSON line per request (Vercel Logs); the
forwarder logs to CloudWatch. JSON rather than sentences because these can
be filtered and alerted on: *every 401 in the last hour*, *p95 duration by
path*, *runs where `published` was 0*.

Never logged: request bodies, `Authorization` headers, tokens, query
strings. Lecture 7's point is that logs are themselves security-sensitive —
a log holding a bearer token hands anyone with log access a working login.
The user **id** is logged, which is enough to investigate and useless for
impersonation.

---

## What each threat now has standing in front of it

| Threat | Cloud service | Code control |
|---|---|---|
| Flooding, bots | Upstash Redis, Cloudflare Turnstile | three rate-limit tiers, body and page caps |
| SQL injection | Neon role scoping | bind parameters everywhere, UUID checks, `CHECK` constraints |
| Role escalation | — | `requireAuth` + `requireRole`, hashed session lookup, audit log |
| Leaked credentials | Vercel encrypted env vars, Lambda config, GitHub secret scanning | `.gitignore`, `.env.example` only |
| XSS | CSP via `vercel.json`, `default-src 'none'` on the API | length and character rules, `textContent` in the frontend |
| Hostile origin | HSTS | CORS allow-list from `CORS_ORIGINS` |
| Lost cancellation alert | SNS + Lambda + EventBridge | transactional outbox, at-least-once |
| Compromised function | IAM least privilege | scoped internal key: read and acknowledge only |
| No audit trail | Vercel Logs, CloudWatch | `audit_log`, request ids |

Every row has both a cloud service and a code control, except role
escalation, which is an application-logic problem by nature and has no cloud
equivalent that would help.

---

## Cost

Everything is on a free plan, and none of it needs a payment card.

| Service | Free allowance | Our use |
|---|---|---|
| Vercel Hobby | 1,000,000 invocations/month | a few thousand |
| Neon Free | 1 GB, 100 compute-hours/month | a handful of small tables |
| Upstash Free | 10,000 commands/day | two per rate-limited request |
| Cloudflare Turnstile | unlimited | writes only |
| AWS (or Floci locally) | free tier; Floci costs nothing at all | one topic, one small function every 5 minutes |
