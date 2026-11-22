// Event forwarder: drains the route_events outbox into Amazon SNS.
//
// Why this exists
// ---------------
// Cancelling a trip has to reach the Favorites & Alerts service so parents
// are told. Calling that service directly from inside the cancel request is
// the obvious design and the wrong one: the HTTP call is outside the database
// transaction, so if Ali's service is slow or down, the trip is cancelled and
// the alert is simply lost, with nobody aware. The admin sees success and the
// parents stand at the kerb.
//
// So the cancel writes the event into route_events in the same transaction as
// the status change (see services/routes.js). This function, on an
// EventBridge schedule, reads the unpublished rows, publishes them to an SNS
// topic and marks them published. Consumers subscribe to the topic instead of
// being called by us, so adding a fourth consumer later changes nothing here.
//
// Delivery is at-least-once: a crash between publish and acknowledge replays
// the event. Consumers must therefore treat the event id as an idempotency
// key, which is why the id is in both the message body and a message
// attribute.
//
// Runtime: nodejs20.x or later. @aws-sdk/* ships with the Lambda runtime, so
// this file needs no bundling and no node_modules.

import { SNSClient, PublishBatchCommand } from '@aws-sdk/client-sns';

const sns = new SNSClient({});

const API_BASE = process.env.ROUTE_STOP_API_URL; // e.g. https://school-bus-route-stop.vercel.app
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
const TOPIC_ARN = process.env.EVENTS_TOPIC_ARN;
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 100);

// SNS PublishBatch takes at most 10 entries per call.
const SNS_BATCH_LIMIT = 10;

export const handler = async () => {
  for (const name of ['ROUTE_STOP_API_URL', 'INTERNAL_API_KEY', 'EVENTS_TOPIC_ARN']) {
    if (!process.env[name]) {
      throw new Error(`${name} is not set on the function`);
    }
  }

  const events = await fetchPending();
  if (events.length === 0) {
    console.log(JSON.stringify({ level: 'info', msg: 'no pending events' }));
    return { published: 0 };
  }

  const published = [];
  const failed = [];

  for (let index = 0; index < events.length; index += SNS_BATCH_LIMIT) {
    const slice = events.slice(index, index + SNS_BATCH_LIMIT);
    const response = await sns.send(
      new PublishBatchCommand({
        TopicArn: TOPIC_ARN,
        PublishBatchRequestEntries: slice.map((event) => ({
          Id: event.id,
          Subject: event.event_type,
          Message: JSON.stringify({
            event_id: event.id,
            event_type: event.event_type,
            route_id: event.route_id,
            trip_id: event.trip_id,
            occurred_at: event.occurred_at,
            payload: event.payload
          }),
          MessageAttributes: {
            // Lets a subscriber filter at the topic ("only trip.cancelled")
            // instead of receiving everything and discarding most of it.
            event_type: { DataType: 'String', StringValue: event.event_type },
            event_id: { DataType: 'String', StringValue: event.id }
          }
        }))
      })
    );

    published.push(...(response.Successful ?? []).map((entry) => entry.Id));
    for (const failure of response.Failed ?? []) {
      failed.push({ id: failure.Id, reason: failure.Message });
    }
  }

  // Only acknowledge what SNS actually accepted. Anything that failed stays
  // unpublished and is retried on the next run, which is the whole point of
  // keeping the outbox rather than firing and forgetting.
  if (published.length > 0) {
    await acknowledge(published);
  }

  console.log(
    JSON.stringify({
      level: failed.length > 0 ? 'warn' : 'info',
      msg: 'outbox drained',
      published: published.length,
      failed: failed.length,
      failures: failed.slice(0, 5)
    })
  );

  return { published: published.length, failed: failed.length };
};

async function fetchPending() {
  const response = await fetch(`${API_BASE}/api/internal/events?limit=${BATCH_SIZE}`, {
    headers: { 'X-Internal-Key': INTERNAL_KEY },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    throw new Error(`Could not read the outbox: HTTP ${response.status}`);
  }
  const body = await response.json();
  return body.items ?? [];
}

async function acknowledge(eventIds) {
  const response = await fetch(`${API_BASE}/api/internal/events/ack`, {
    method: 'POST',
    headers: {
      'X-Internal-Key': INTERNAL_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ event_ids: eventIds }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    // Not fatal: the events were delivered. Failing to acknowledge means they
    // are sent again next run, which the consumers already handle.
    console.error(
      JSON.stringify({ level: 'error', msg: 'acknowledge failed', status: response.status })
    );
  }
}
