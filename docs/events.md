# Events published by the Route & Stop service

For the Favorites & Alerts service (Ali). This is the contract: what arrives
on the SNS topic, what each field means, and what a consumer has to handle.

## How to receive them

Subscribe the existing SQS queue to the SNS topic rather than having this
service call the queue directly. One publisher, any number of consumers, and
adding a third later changes nothing here.

```bash
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:000000000000:school-bus-route-events \
  --protocol sqs \
  --notification-endpoint arn:aws:sqs:us-east-1:000000000000:favorites-alerts-queue \
  --attributes RawMessageDelivery=true
```

`RawMessageDelivery=true` matters. Without it SNS wraps the payload in its
own envelope and the real message arrives as a JSON **string** inside a
`Message` field, so the queue sees a shape it does not recognise. With it,
the body below is delivered as-is.

Only want cancellations? Filter at the subscription instead of receiving
everything and discarding most of it:

```bash
aws sns set-subscription-attributes \
  --subscription-arn <arn> \
  --attribute-name FilterPolicy \
  --attribute-value '{"event_type":["trip.cancelled"]}'
```

The filter reads the `event_type` **message attribute**, which is set on
every message alongside the body.

## Message body

```json
{
  "event_id": "9f1c…",
  "event_type": "trip.cancelled",
  "route_id": "3a7e…",
  "trip_id": "c42b…",
  "occurred_at": "2026-03-01T06:12:44.182Z",
  "payload": {
    "service_date": "2026-03-01",
    "run_type": "morning",
    "route_code": "R-01",
    "reason": "Bus 14 is in for repair",
    "stop_ids": ["…", "…", "…"],
    "affected_students": 12
  }
}
```

| Field | Always present | Meaning |
|---|---|---|
| `event_id` | yes | uuid, unique per event. **Use it as the idempotency key.** |
| `event_type` | yes | see the table below |
| `route_id` | on route-scoped events | the route |
| `trip_id` | on trip events only | the trip |
| `occurred_at` | yes | when it happened, not when it was delivered |
| `payload` | yes | shape depends on `event_type` |

Message attributes: `event_type` and `event_id`, both strings.

## Event types

| `event_type` | When | `payload` |
|---|---|---|
| `trip.cancelled` | an admin cancels a trip | `service_date`, `run_type`, `route_code`, `reason`, `stop_ids[]`, `affected_students` |
| `trip.created` | a single trip is created by hand | `service_date`, `run_type`, `bus_id` |
| `trips.generated` | a generation run commits | `from`, `to`, `route_id`, `planned`, `by` |

`trip.cancelled` is the one that has to reach parents. The other two are
there so a consumer can keep a local view in step; ignoring them is fine.

`stop_ids` is what maps a cancellation to the families to notify: a parent's
saved stop appearing in that list means their child is affected.
`affected_students` is this service's own count and is `null` when the
`students` table is not reachable — treat it as information, not as the list.

## Two things a consumer must handle

**Duplicates.** Delivery is at-least-once. A crash between publishing and
acknowledging replays the event, so the same `event_id` can arrive twice.
Record the ids you have processed and skip repeats; sending a parent the
same cancellation twice is a worse bug than a slightly late alert.

**Lateness.** The forwarder runs every five minutes, so an alert can lag the
cancellation by that much. Read the time from `occurred_at`, not from when
the message arrived, or a message delayed by a retry will be shown as having
just happened.

## Why it works this way

The alternative was for this service to call the alerts API directly inside
the cancel request. That call sits outside the database transaction, so if
the alerts service were slow or down the trip would be cancelled and the
alert silently lost: the admin sees success and the parents wait at the kerb.

Instead the cancellation and the event row are written in one transaction —
either both land or neither does — and a Lambda drains the table to SNS on a
schedule. If the consumer is down the events wait. Nothing is lost, and the
two services are not coupled to each other's uptime.

Full reasoning: [`architecture.md`](architecture.md) §5.4.
