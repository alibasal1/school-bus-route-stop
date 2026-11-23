# Threat model — Route & Stop

Service owner: Yahia Wael (247330), Team 14.

Scope: this service only — routes, stops, buses, schedules and trips. Login
belongs to Schedule & Arrival; alerts belong to Favorites & Alerts. Where a
threat crosses a boundary, that is said.

The Phase 1 feedback was that the proposal's mitigations were almost all
application code, with little use of cloud services. Each row below names
both: the control in the code **and** the cloud service standing in front of
it. That is defence in depth from Lecture 9 — no single control is the only
thing between an attacker and the data.

---

## Assets

| Asset | Why it matters | Worst case |
|---|---|---|
| Timetable data | Families plan their morning around it | A child is sent to a stop with no bus |
| `DATABASE_URL` | Full read/write on every table of all three services | Total compromise |
| `INTERNAL_API_KEY` | Opens `/api/internal/*` | Forged events, mass trip generation |
| Session tokens | Impersonation of an admin | Anything an admin can do |
| Availability | A free-tier database with a monthly budget | One scripted loop takes the app down for every family |
| `audit_log` | The record of who changed what | An incident with no evidence |

## Trust boundaries

1. **Browser → API.** The main one. Everything crossing it is untrusted.
2. **Service → service.** Reads of `users`, `students`, `holidays`; events
   out to Favorites & Alerts.
3. **API → platform.** Neon, Upstash, Cloudflare, SNS.
4. **Developer → repository.** Where secrets leak if they leak.

---

## Threats and mitigations

### T1 — Automated clients flooding the API

*An attacker, or a buggy frontend loop, calls `GET /api/routes` or
`POST /api/trips` thousands of times a minute.*

Neon's free plan has 100 compute-hours a month; exhausting it pauses the
database for everyone. This is a denial of service that costs the attacker
nothing.

| Layer | Control |
|---|---|
| Cloud | **Upstash Redis** holds the counters, so the limit is shared across every Vercel instance. An in-memory counter is per-instance, and a platform that scales to ten instances turns "20 a minute" into 200. |
| Cloud | **Cloudflare Turnstile**, verified server-side, on writes. |
| Code | Three budgets: reads 120/min, writes 20/min, generation 5 per 5 min, each keyed by user id when logged in and by IP otherwise. |
| Code | `limit` capped at 100–200, generation capped at 120 days, body capped at 32 kb. |

The rate limiter **fails open** if Upstash is unreachable, because a limiter
that takes the API down when its own store is down has become the outage it
was meant to prevent. Turnstile **fails closed**, because allowing
unverified writes whenever Cloudflare is slow would hand the attacker the
bypass: time the check out, then write freely. The difference is deliberate.

### T2 — SQL injection

*A route name or search term carries SQL.*

| Layer | Control |
|---|---|
| Code | Every value reaches Postgres as a bind parameter via `sql\`…${value}\``. No statement anywhere is built by joining strings — the bulk reorder and the bulk insert use `unnest` with arrays rather than a generated `VALUES` list. |
| Code | Ids are checked against a UUID pattern before the query, so `1' OR '1'='1` is a 400, not a query. |
| Data | `CHECK` constraints on `run_type` and `status`; a `DEFERRABLE UNIQUE` on stop order. |
| Cloud | Neon's role has rights on this database only. |

### T3 — A parent or supervisor acting as an admin

*A logged-in parent calls `POST /api/routes`, or edits the id in a URL.*

| Layer | Control |
|---|---|
| Code | `requireAuth` and `requireRole('admin')` on every write, applied in `routes/routes.js` where the whole access map can be read at once. Hiding a button is not access control. |
| Code | Authentication and authorisation are separate functions, so "has a token" can never be mistaken for "is an admin". |
| Code | Tokens are looked up as SHA-256 hashes with an expiry check; one message for unknown and expired, so the API does not confirm which tokens exist. |
| Audit | Every state-changing action lands in `audit_log` with user, role, resource and status. |

Object-level ownership is thin here by nature: route and trip data is the
same for every parent, so there is no per-user row to leak. The ownership
rules that matter live in the other two services.

### T4 — Credentials leaking through the repository

*`DATABASE_URL` or a key is committed.*

| Layer | Control |
|---|---|
| Code | `.env` is in `.gitignore`; only `.env.example` is committed, with placeholders and a warning. |
| Cloud | Real values live in Vercel's encrypted environment variables and the Lambda configuration. |
| Process | Gitleaks in CI before merge; GitHub secret scanning is on for the repository. |
| Response | If one leaks: reset the Neon role password, rotate `INTERNAL_API_KEY`, redeploy. Rotating is cheap because nothing reads a secret from code. |

### T5 — Cross-site scripting through stop or route names

*An admin saves `<script>…</script>` as a stop name; a parent opens the page.*

| Layer | Control |
|---|---|
| Code (frontend) | React escapes interpolated text, and the vanilla pages use `textContent`, never `innerHTML`. |
| Code (API) | Lengths and character rules on every text field. |
| Cloud | CSP on the frontend via `vercel.json`, and `default-src 'none'` on the API itself, so a JSON response can never be rendered as a page. |

The API deliberately **stores** what it is given rather than stripping tags:
escaping belongs at the point of display, and an API that silently rewrites
input makes the stored data disagree with what the admin typed.

### T6 — A hostile site calling the API with a parent's session

*A parent visits `evil.example`, which fetches our API from their browser.*

| Layer | Control |
|---|---|
| Code | CORS allow-list from `CORS_ORIGINS`; unknown origins get no allow header and are logged. Never a wildcard. |
| Code | Sessions are bearer tokens, not cookies, so there is nothing for a browser to attach automatically — CSRF does not apply. |
| Cloud | HSTS and HTTPS everywhere. |

CORS protects browsers only; curl ignores it. It is a layer, not the
boundary. The boundary is `requireAuth` plus `requireRole`.

### T7 — A cancellation that nobody hears about

*A trip is cancelled while the Favorites & Alerts service is down. Parents
are never told and wait at the kerb.*

This is the threat with a real safety cost, and it is not a security control
in the usual sense — it is an integrity one.

| Layer | Control |
|---|---|
| Data | The status change and the `route_events` row are written in **one transaction**. Either both land or neither does. |
| Cloud | An AWS Lambda on an **EventBridge** schedule publishes unpublished events to an **SNS** topic and marks them published. If the consumer is down, events wait in the table. |
| Code | At-least-once delivery; the event id is the consumer's idempotency key. |
| Ops | Unpublished rows older than a few minutes are a visible backlog in `route_events`. |

### T8 — A compromised Lambda reaching further than it should

*The forwarder is compromised.*

| Layer | Control |
|---|---|
| Cloud | Its IAM role may `sns:Publish` to **one** topic ARN and write **its own** log group. No database access, no other topic, no delete, no `"*"`. |
| Cloud | `lambda add-permission` limits who may invoke it to the EventBridge rule. |
| Code | It holds `INTERNAL_API_KEY`, which only opens read-and-acknowledge on the outbox — it cannot create, cancel or delete anything. |

Lecture 7's point about the inside of the boundary: once something is in,
the only thing limiting the damage is what its identity is allowed to do.

### T9 — Losing the record of what happened

*Someone cancels a month of trips and nobody can say who.*

| Layer | Control |
|---|---|
| Code | `audit_log`: service, user, role, action, resource, status, request id. |
| Code | One structured JSON log line per request, with the request id echoed in every error body. |
| Code | Bodies, tokens, `Authorization` headers and query strings are never logged. A log holding a bearer token hands anyone with log access a working login. |
| Cloud | Vercel Logs, and CloudWatch for the Lambda. |
| Code | The audit write can never fail the request it describes. |

---

## Risk summary

| # | Threat | Likelihood | Impact | After controls |
|---|---|---|---|---|
| T1 | Flooding / bots | High | High (budget exhausted) | Low |
| T2 | SQL injection | Medium | Critical | Very low |
| T3 | Role escalation | Medium | High | Low |
| T4 | Leaked credentials | Medium | Critical | Low |
| T5 | XSS | Low | Medium | Low |
| T6 | Hostile origin | Medium | Medium | Low |
| T7 | Lost cancellation alert | Medium | **High (safety)** | Low |
| T8 | Over-permissioned Lambda | Low | High | Very low |
| T9 | No audit trail | Medium | Medium | Low |

## Accepted, with reasons

- **No WAF.** Cloudflare's managed rules would sit in front of the API, but
  that needs a custom domain the team does not have. Rate limiting and
  Turnstile cover the realistic traffic threats for a project of this size.
- **No encryption beyond the platform's.** Neon encrypts at rest and TLS
  protects transit. This service stores no personal data of its own — names
  of roads, not of children.
- **No automated secret rotation.** Manual, documented, and realistic for a
  three-person team over one term.
- **Rate limiting is fail-open.** Stated above; availability is worth more
  here than a hard stop when Upstash blips.
