// DynamoDB access for the Route & Stop service.
//
// Replaces Neon. One database for the whole team, on Floci, using Ahmed's
// table design. Table names are read from the environment so a test run or a
// second stack can point at different tables without touching code.
//
// Which tables this service may touch (see docs/architecture.md):
//   write  Routes, Stops, Buses, RouteSchedules, TripEvents
//   write  Trips, TripStops  (this service creates and cancels; Ahmed reads)
//   read   Users, Sessions   (owned by Ahmed's auth service)
//
// Everything goes through the Document client, so items are plain JavaScript
// objects rather than {"S": "..."} shapes. Values are always passed as
// ExpressionAttributeValues, never pasted into an expression string, for the
// same reason SQL used bind parameters: an id that contains an expression
// must stay a value.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  DeleteCommand,
  BatchWriteCommand,
  TransactWriteCommand,
} = require('@aws-sdk/lib-dynamodb');

const PREFIX = process.env.TABLE_PREFIX || '';

const TABLES = {
  ROUTES: `${PREFIX}Routes`,
  STOPS: `${PREFIX}Stops`,
  BUSES: `${PREFIX}Buses`,
  TRIPS: `${PREFIX}Trips`,
  TRIP_STOPS: `${PREFIX}TripStops`,
  SCHEDULES: `${PREFIX}RouteSchedules`,
  EVENTS: `${PREFIX}TripEvents`,
  USERS: `${PREFIX}Users`,
  SESSIONS: `${PREFIX}Sessions`,
};

const INDEXES = {
  ROUTE_NAME: 'name-index',
  ROUTE_AREA: 'area-index',
  BY_ROUTE: 'route-id-index',
  BY_SUPERVISOR: 'supervisor-id-index',
};

let documentClient = null;

/**
 * Built on first use, not when this file is required.
 *
 * On Lambda the region and the endpoint are in the environment before the
 * handler runs, but secrets arrive later (config/secrets.js), and building
 * lazily keeps every entry point behaving the same way.
 *
 * AWS_ENDPOINT_URL is what points the SDK at Floci. Unset, the SDK talks to
 * real AWS, so the same code runs in both places with no branch.
 */
function client() {
  if (documentClient) return documentClient;

  const config = { region: process.env.AWS_REGION || 'us-east-1' };
  if (process.env.AWS_ENDPOINT_URL) {
    config.endpoint = process.env.AWS_ENDPOINT_URL;
  }

  documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(config), {
    marshallOptions: {
      // An attribute that is undefined should not be written at all, rather
      // than stored as a null that later reads have to special-case.
      removeUndefinedValues: true,
      convertEmptyValues: false,
    },
  });
  return documentClient;
}

async function getItem(TableName, Key) {
  const result = await client().send(new GetCommand({ TableName, Key }));
  return result.Item || null;
}

async function putItem(TableName, Item, options = {}) {
  await client().send(new PutCommand({ TableName, Item, ...options }));
  return Item;
}

async function updateItem(TableName, Key, options) {
  const result = await client().send(
    new UpdateCommand({ TableName, Key, ReturnValues: 'ALL_NEW', ...options })
  );
  return result.Attributes || null;
}

async function deleteItem(TableName, Key, options = {}) {
  await client().send(new DeleteCommand({ TableName, Key, ...options }));
}

/**
 * Query, following pagination to the end.
 *
 * DynamoDB answers at most 1 MB at a time and reports LastEvaluatedKey when
 * there is more. Code that ignores it silently returns a partial answer,
 * which is the classic DynamoDB bug: it works in testing with ten rows and
 * quietly loses data later.
 */
async function queryAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await client().send(new QueryCommand({ ...params, ExclusiveStartKey }));
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/**
 * Scan, following pagination, with a hard cap.
 *
 * Used only for the route search, where the whole table is a handful of
 * routes for one school. A scan reads every item, so it is the wrong tool
 * once the table is large; the cap stops it from becoming an accidental
 * denial of service against our own account, and docs/architecture.md says
 * what to do instead if the data grows.
 */
async function scanAll(params, { maxItems = 2000 } = {}) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await client().send(new ScanCommand({ ...params, ExclusiveStartKey }));
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey && items.length < maxItems);
  return items.slice(0, maxItems);
}

/**
 * All-or-nothing writes, up to 100 items.
 *
 * This is what replaces the SQL transaction. A stop reorder either applies
 * completely or not at all, so the order is never left with a gap.
 */
async function transactWrite(TransactItems) {
  if (TransactItems.length === 0) return;
  if (TransactItems.length > 100) {
    throw Object.assign(new Error('Too many items for one transaction (limit 100).'), {
      code: 'VALIDATION_ERROR',
      expose: true,
    });
  }
  await client().send(new TransactWriteCommand({ TransactItems }));
}

/** Unordered bulk writes in chunks of 25, with retries for what is unprocessed. */
async function batchWrite(TableName, requests) {
  for (let i = 0; i < requests.length; i += 25) {
    let chunk = requests.slice(i, i + 25);
    for (let attempt = 0; attempt < 5 && chunk.length > 0; attempt += 1) {
      const result = await client().send(
        new BatchWriteCommand({ RequestItems: { [TableName]: chunk } })
      );
      chunk = (result.UnprocessedItems && result.UnprocessedItems[TableName]) || [];
      if (chunk.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }
  }
}

/** Used by /api/ready: proves the service can actually reach DynamoDB. */
async function ping() {
  await client().send(new ScanCommand({ TableName: TABLES.ROUTES, Limit: 1 }));
  return true;
}

/** Lets the tests swap in a fake client. See tests/helpers/fakeDynamo.js. */
function __setClient(fake) {
  documentClient = fake;
}

module.exports = {
  TABLES,
  INDEXES,
  client,
  getItem,
  putItem,
  updateItem,
  deleteItem,
  queryAll,
  scanAll,
  transactWrite,
  batchWrite,
  ping,
  __setClient,
};
