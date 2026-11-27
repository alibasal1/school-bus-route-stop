# Deploying Route & Stop on Floci

One command:

```bash
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1
bash infra/deploy.sh
```

Re-runnable. Every step either creates the thing or updates it, so running
it twice is not an error. If Floci is restarted and loses everything, this
rebuilds it from nothing.

`MSYS_NO_PATHCONV=1` matters in Git Bash: without it, an argument starting
with `/` (such as `/aws/lambda/route-stop-api`) is rewritten into a Windows
path and the call fails in a confusing way.

## What it builds

Everything is prefixed `route-stop-`, so nothing here can touch Ali's
resources, which start with `favorites-alerts-`.

| Step | What |
|---|---|
| 1 | DynamoDB tables with their GSIs |
| 2 | IAM role and a least-privilege policy |
| 3 | Secrets Manager, only if a Turnstile key is set |
| 4 | `npm run zip` builds the deployment package |
| 5 | Lambda `route-stop-api`, Node 20 |
| 6 | API Gateway `route-stop-http-api`, throttling 10 rps burst 20 |
| 7 | EventBridge daily rule for trip generation |
| 8 | CloudWatch log group, SECURITY metric filter, alarm |

It prints the API address at the end.

## Tables

Owned by this service: `Routes`, `Stops`, `Buses`, `RouteSchedules`,
`TripEvents`, `IdempotencyKeys`.

Ahmed's, created here **only if missing** so this service can run on a clean
Floci without waiting for his deploy: `Trips`, `TripStops`, `Users`,
`Sessions`. If his script ran first, they are left exactly as they are.

Billing is `PAY_PER_REQUEST`: nothing to guess, nothing to pay when idle.

## The IAM policy

The part worth reading. Four statements, each naming its resources:

```
WriteOwnTables          Routes, Stops, Buses, RouteSchedules, TripEvents,
                        Trips, TripStops   (+ their indexes)
ReadAuthTablesOnly      Users, Sessions    GetItem and Query only
SendToAlertsQueueOnly   sqs:SendMessage on one queue ARN
OwnLogsOnly             /aws/lambda/route-stop-*
```

No `"*"` resource anywhere. A fully compromised function cannot create a
user, grant itself a role, read Ali's tables, or touch another queue. That
is the whole blast radius, and it is the answer to two of the threats in
`docs/threat-model.md`.

Two kinds of permission are involved, as Lab 7 sets out: the **execution
role** says what the function may do, and `lambda add-permission` says
**who may invoke it**. Real AWS checks both. Floci stores them without
enforcing, so a policy that is too narrow passes here and fails on a real
account.

## After deploying

```bash
npm run seed                          # 2 routes, 3 stops each, buses, trips
node scripts/make-test-sessions.js    # writes .test-tokens.local
source .test-tokens.local

export API=http://<api-id>.execute-api.localhost.floci.io:4566
curl "$API/api/health"
curl "$API/api/ready"
curl "$API/api/routes" -H "Authorization: Bearer $ADMIN_TOKEN"
```

Logs:

```bash
aws logs tail /aws/lambda/route-stop-api --since 10m --format short
aws logs tail /aws/lambda/route-stop-api --since 10m --format short | grep SECURITY
```

Clean up the demo data (dry run unless `--yes`):

```bash
npm run cleanup
npm run cleanup -- --yes
```

## Order on the demo machine

1. **This script first.** It creates the tables, including Ahmed's if they
   are missing.
2. **Ali's `deploy.sh` next.** It creates `favorites-alerts-queue` and his
   consumer.
3. Then the joint cancel test (ST-09 in `docs/api-test-plan.md`).

If Ali's queue does not exist yet, cancelling still works: the event is
stored in `TripEvents` as unsent, and the daily run (or
`POST /api/internal/events/retry`) delivers it once the queue is there.

## Environment variables

Set on the Lambda by the script. None of them is a secret, because DynamoDB
access comes from the IAM role rather than a credential:

| Variable | What |
|---|---|
| `NODE_ENV` | `production` |
| `CORS_ORIGINS` | `http://localhost:5173` by default |
| `AWS_ENDPOINT_URL` | points the SDK at Floci |
| `ALERTS_QUEUE_URL` | Ali's queue |
| `INTERNAL_API_KEY` | generated if not supplied; opens `/api/internal/*` |
| `SECRET_ID` | only when a Turnstile key was configured |

`.env` is for local runs only and is in `.gitignore`. Never commit it.

## When something fails

| Symptom | Likely cause |
|---|---|
| `Cannot reach Floci` | Docker is not running, or `AWS_PROFILE` is not `floci` |
| Every POST returns 400 | the Buffer body fix in `lambda.js` is missing |
| `ResourceNotFoundException` | the tables were not created; re-run step 1 |
| `AccessDeniedException` | the IAM policy is too narrow for a new table |
| 503 from `/api/ready` | the function cannot reach DynamoDB; check `AWS_ENDPOINT_URL` |
| Alerts never arrive | Ali's queue does not exist yet; check `TripEvents` for unsent rows |
