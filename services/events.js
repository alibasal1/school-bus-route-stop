// Trip events out to the Favorites & Alerts service.
//
// Ali removed SNS, so each event now goes straight to his SQS queue with
// SendMessage. The body shape is unchanged from docs/events.md, because his
// consumer already reads it.
//
// The outbox is kept, in a simpler form than the SQL version. A trip change
// writes a row to TripEvents and then tries to send it. If the send works,
// the row is marked sent. If it does not, the row stays unsent and the daily
// EventBridge run picks it up.
//
// Why keep it at all when the queue is usually up: cancelling a trip and
// telling the parents must not come apart. Sending inside the request and
// hoping is how an admin sees "cancelled" while nobody is told, and the
// parents find out at the kerb. The row is written first, so a failed send
// is a retry rather than a silent loss.
//
// Delivery is at-least-once, which is why event_id exists: Ali stores it in
// processed_events and skips repeats.

const { randomUUID } = require('crypto');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { TABLES, putItem, queryAll, updateItem } = require('../db/dynamo');

const QUEUE_URL =
  process.env.ALERTS_QUEUE_URL || 'http://localhost:4566/000000000000/favorites-alerts-queue';

let sqs = null;
function client() {
  if (sqs) return sqs;
  const config = { region: process.env.AWS_REGION || 'us-east-1' };
  if (process.env.AWS_ENDPOINT_URL) config.endpoint = process.env.AWS_ENDPOINT_URL;
  sqs = new SQSClient(config);
  return sqs;
}

/** The event types Ali's consumer reads. */
const EVENT_TYPES = {
  TRIP_CANCELLED: 'trip.cancelled',
  TRIP_CREATED: 'trip.created',
};

/**
 * Build the message body. Exactly the shape in docs/events.md.
 *
 * Kept as its own function so the tests can check the shape without an AWS
 * client, and so there is one place where the contract with Ali lives.
 */
function buildEvent({ eventType, routeId, tripId, payload }) {
  return {
    event_id: randomUUID(),
    event_type: eventType,
    route_id: routeId,
    trip_id: tripId,
    occurred_at: new Date().toISOString(),
    payload,
  };
}

/**
 * Record the event, then try to deliver it.
 *
 * Never throws. A trip was already created or cancelled by the time this
 * runs, and failing the request afterwards would tell the admin the change
 * did not happen when it did. A failed send is logged and left unsent for
 * the retry sweep.
 */
async function publish({ eventType, routeId, tripId, payload }) {
  const event = buildEvent({ eventType, routeId, tripId, payload });

  try {
    await putItem(TABLES.EVENTS, { ...event, sent: 'no', attempts: 0 });
  } catch (error) {
    console.error(
      JSON.stringify({ level: 'error', msg: 'could not record event', error: error.message })
    );
    // Still try to send: a delivered alert matters more than a logged one.
  }

  const delivered = await send(event);
  if (delivered) await markSent(event.event_id);
  return { ...event, delivered };
}

/** One SendMessage. Returns true when the queue accepted the message. */
async function send(event) {
  try {
    await client().send(
      new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify(event),
        // Ali's consumer filters on event_type. It is in the body as well,
        // so a consumer that ignores attributes still works.
        MessageAttributes: {
          event_type: { DataType: 'String', StringValue: event.event_type },
          event_id: { DataType: 'String', StringValue: event.event_id },
        },
      })
    );
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'event sent',
        event_id: event.event_id,
        event_type: event.event_type,
        trip_id: event.trip_id,
      })
    );
    return true;
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'event send failed, left for retry',
        event_id: event.event_id,
        event_type: event.event_type,
        error: error.message,
      })
    );
    return false;
  }
}

async function markSent(eventId) {
  try {
    await updateItem(
      TABLES.EVENTS,
      { event_id: eventId },
      {
        UpdateExpression: 'SET #sent = :yes, sent_at = :now',
        ExpressionAttributeNames: { '#sent': 'sent' },
        ExpressionAttributeValues: { ':yes': 'yes', ':now': new Date().toISOString() },
      }
    );
  } catch (error) {
    // The alert was delivered; the worst case is that the sweep sends it
    // again, and Ali skips repeats by event_id.
    console.warn(
      JSON.stringify({ level: 'warn', msg: 'could not mark event sent', event_id: eventId })
    );
  }
}

/**
 * Retry everything still unsent. Called by the daily scheduled run.
 *
 * Uses the sent-index GSI so it reads only the unsent events, rather than
 * scanning every event ever written.
 */
async function retryUnsent({ limit = 50 } = {}) {
  let pending;
  try {
    pending = await queryAll({
      TableName: TABLES.EVENTS,
      IndexName: 'sent-index',
      KeyConditionExpression: '#sent = :no',
      ExpressionAttributeNames: { '#sent': 'sent' },
      ExpressionAttributeValues: { ':no': 'no' },
      Limit: limit,
    });
  } catch (error) {
    console.error(
      JSON.stringify({ level: 'error', msg: 'could not read unsent events', error: error.message })
    );
    return { retried: 0, delivered: 0 };
  }

  let delivered = 0;
  for (const event of pending.slice(0, limit)) {
    const { sent, attempts, sent_at, ...body } = event;
    if (await send(body)) {
      await markSent(body.event_id);
      delivered += 1;
    } else {
      await updateItem(
        TABLES.EVENTS,
        { event_id: body.event_id },
        {
          UpdateExpression: 'SET attempts = if_not_exists(attempts, :zero) + :one',
          ExpressionAttributeValues: { ':zero': 0, ':one': 1 },
        }
      ).catch(() => {});
    }
  }

  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'unsent event sweep',
      found: pending.length,
      delivered,
    })
  );
  return { retried: pending.length, delivered };
}

module.exports = { EVENT_TYPES, QUEUE_URL, buildEvent, publish, send, retryUnsent };
