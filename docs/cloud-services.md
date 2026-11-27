# Cloud services used by this service, and why

Phase 1 feedback was that the project mirrored the labs and used almost no
cloud services for security or traffic. This is the answer for Route & Stop,
now that everything runs on Floci.

Each entry says what the service is, which problem it solves, and what
happens without it. Setup commands are in [../infra/README.md](../infra/README.md);
the threats are in [threat-model.md](threat-model.md).

| Service | Category | Solves |
|---|---|---|
| DynamoDB | data | the whole team's database, one table design |
| Lambda | compute | runs the API, no server to keep alive |
| API Gateway | edge | the public address, throttling, only our routes |
| SQS (sender) | integration | cancellations reach Ali without coupling |
| EventBridge | automation | daily trip generation and the event sweep |
| CloudWatch Logs | operations | SECURITY metric filter and an alarm |
| IAM | security | least privilege, the blast radius |

Seven, where three are required.

---

## 1. DynamoDB

Replaces Neon. One database shared by the three services, using Ahmed's
table design, so the Schedule page and the "next bus" panel read the same
trips this service writes.

**Why it changes the code:** there are no joins and no transactions across
arbitrary rows. `stop_count` is counted, not joined. The stop reorder uses
`TransactWriteItems` rather than a deferrable constraint. Route search is a
Scan, which is right for a handful of routes and documented as the first
thing to change if the data grows.

**Security angle worth saying out loud:** there is no connection string.
Access comes from the Lambda's IAM role, so there is no credential in the
code, in an environment variable, or in a backup to leak. That is a
stronger control than anything we did with Neon.

## 2. Lambda

The API itself. `lambda.js` wraps the same `app.js` that `server.js` runs
locally, so there is one code path, not two.

**The one real trap:** serverless-http hands Express 5 the body as a
Buffer, so every field reads as `undefined` and every POST and PATCH comes
back 400. `lambda.js` converts it before Express sees it.

## 3. API Gateway

Only this service's routes are registered, plus OPTIONS for the browser
preflight. No catch-all, so a path that does not exist is refused at the
edge instead of waking the function.

Throttling is set to 10 rps, burst 20. **Floci records this but does not
enforce it**, which is exactly why `middleware/rateLimit.js` also limits per
source address: on the demo machine, the application limit is the only one
that fires. On real AWS both apply, which is the Lab 8 point about defence
in depth.

## 4. SQS, as sender only

Replaces SNS, because Ali removed the topic. Each trip event goes straight
to `favorites-alerts-queue` with SendMessage.

**Why a queue rather than calling his API:** an HTTP call inside the cancel
request sits outside everything else, so if his service is slow or down the
trip is cancelled and the alert is lost. The admin sees success and the
parents wait at the kerb. With a queue, his downtime is a delay, not a lost
alert, and neither service depends on the other being up.

Permission is `sqs:SendMessage` on that one queue ARN. This service cannot
read it, delete from it, or touch any other queue.

## 5. EventBridge

A daily rule that calls trip generation and sweeps any event whose send
failed. Replaces the Vercel cron.

On Floci the rule cannot call an HTTP address, so it invokes the function
with an event shaped like an API Gateway GET. The same handler understands
it, so there is no second code path to keep working.

## 6. CloudWatch Logs

One JSON line per request, and a `SECURITY` line for every refusal. JSON
rather than sentences because these can be filtered and alerted on: *every
401 in the last hour*, *p95 by path*. `infra/deploy.sh` adds a metric filter
on `{ $.event = "SECURITY" }` and an alarm above 20 in five minutes, so a
flood becomes a number on a graph rather than a line nobody reads.

Never logged: bodies, Authorization headers, tokens, query strings.

## 7. IAM

The control that decides how bad a compromise is. Four statements, each
naming its resources:

- write on the tables this service owns
- **read only** on `Users` and `Sessions`
- `sqs:SendMessage` on one queue ARN
- logs in one log group

No `"*"` resource. A fully compromised function cannot create a user, grant
itself a role, read Ali's tables, or touch another queue.

Two kinds of permission are involved, as Lab 7 sets out: the execution role
says what the function may do; `lambda add-permission` says who may invoke
it. Real AWS checks both. Floci stores them without enforcing, so a policy
that is too narrow passes on Floci and fails on a real account. Worth saying
in the demo.

## Cost

Floci is free and local. On real AWS all of this sits inside the free tier
at this size: a few thousand Lambda invocations, on-demand DynamoDB with a
few hundred items, and one queue.
