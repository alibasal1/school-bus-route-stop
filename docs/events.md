# Events published by the Route & Stop service

For the Favorites & Alerts service (Ali). This is the contract: what arrives
on the queue, what each field means, and what a consumer has to handle.

**Changed 27/11: SQS SendMessage replaces SNS.** Ali removed the topic, so
this service now sends each event straight to his queue. The message body is
unchanged, so his consumer did not need changing.

Sender: `services/events.js`. Permission: `sqs:SendMessage` on that one queue
ARN and nothing else (`infra/deploy.sh`, statement `SendToAlertsQueueOnly`).

## Where it goes

| | |
|---|---|
| Queue URL | `http://localhost:4566/000000000000/favorites-alerts-queue` |
| Queue ARN | `arn:aws:sqs:us-east-1:000000000000:favorites-alerts-queue` |
| Set by | `ALERTS_QUEUE_URL` on the Lambda |

## Message body

```json
{
  "event_id": "9f1c7a52-0b3e-4f1a-9c21-7d5a1e2f4b60",
  "event_type": "trip.cancelled",
  "route_id": "route-cairo-demo",
  "trip_id": "trip:route-cairo-demo:morning",
  "occurred_at": "2026-11-28T06:12:44.182Z",
  "payload": {
    "service_date": "2026-11-28",
    "run_type": "morning",
    "route_code": "R1",
    "reason": "Bus 14 is in for repair"
  }
}
```

| Field | Always there | Meaning |
|---|---|---|
| `event_id` | yes | unique per event. **Use it as the idempotency key.** |
| `event_type` | yes | `trip.cancelled` or `trip.created` |
| `route_id` | yes | the route |
| `trip_id` | yes | the trip |
| `occurred_at` | yes | when it happened, not when it was delivered |
| `payload.service_date` | on cancel | the day being cancelled; `null` on `trip.created` |
| `payload.run_type` | yes | `morning` or `afternoon` |
| `payload.route_code` | yes | the code a parent would recognise, e.g. `R1` |
| `payload.reason` | on cancel | the text the parent should see |

Message attributes, both strings: `event_type` and `event_id`. `event_type`
is also in the body, so a consumer that ignores attributes still works.

## Two things a consumer must handle

**Duplicates.** Delivery is at-least-once. The sender writes the event to
`TripEvents` first and then sends it; if marking it sent fails, the daily
sweep sends it again. The same `event_id` can therefore arrive twice. Ali
stores processed ids in `processed_events` and skips repeats.

**Lateness.** A send that fails is retried by the daily EventBridge run, so
an event can arrive hours after it happened. Read the time from
`occurred_at`, not from when the message arrived.

## Why the outbox is still there

The alert belongs to Ali's service, and sending inside the request and
hoping is how an admin sees "cancelled" while nobody is told, and the
parents find out at the kerb. So the event is written to `TripEvents` before
it is sent. A failed send is a retry, never a silent loss.

It is simpler than the SQL version: no forwarder Lambda, no topic. The write
and the send are two steps rather than one transaction, which is the honest
trade for the deadline. The window where a row exists and the message does
not is milliseconds, and the sweep closes it.

## Testing it

`tests/api/routes.test.js` mocks the SQS client and asserts:

- cancelling sends **exactly one** message, with the body above
- the `event_type` attribute is set, because Ali's filter reads it
- cancelling a second time is `409` and sends **no** second message, so no
  family is told twice
- creating a trip sends `trip.created`

End to end with Ali: `evidence/joint-cancel-test.txt` (see
`docs/api-test-plan.md`, test ST-09).
