// Neon connection for the Route & Stop service.
//
// Values interpolated into sql`...${value}...` are sent as bind parameters,
// never as SQL text, so user input cannot change the shape of a query.
// Nothing in this service builds SQL by string concatenation.
//
// The client is built on first use, not when this file is required. That
// matters on Lambda: the connection string arrives from Secrets Manager
// after the handler starts (see config/secrets.js), so reading
// process.env.DATABASE_URL at require time would always find it empty.
const { neon } = require('@neondatabase/serverless');

let client = null;
let warned = false;

function connectionString() {
  return (process.env.DATABASE_URL || '').trim();
}

function requireSql() {
  if (client) return client;

  const url = connectionString();
  if (!url) {
    if (!warned) {
      // Never print the value itself, only whether there is one.
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'DATABASE_URL is not set. On a PC copy .env.example to .env; on Lambda check SECRET_ID.',
        })
      );
      warned = true;
    }
    const error = new Error('DATABASE_URL is not configured.');
    error.code = 'DB_NOT_CONFIGURED';
    throw error;
  }

  client = neon(url);
  return client;
}

/**
 * Run several statements inside one transaction.
 *
 * The Neon HTTP driver takes an array of prepared queries and sends them as a
 * single transaction, so either all of them commit or none do. This is what
 * makes the outbox pattern honest: the trip update and the route_events row
 * cannot come apart.
 *
 * Queries cannot read each other's results, so anything that depends on a
 * previous answer is computed in JavaScript first and then written in one go.
 */
function transaction(queries) {
  return requireSql().transaction(queries);
}

/** True when a connection string is present. Used by the start-up log line. */
function isConfigured() {
  return Boolean(connectionString());
}

module.exports = {
  // A getter, so callers that destructure still get a live value rather than
  // whatever existed when this module was first required.
  get sql() {
    return requireSql();
  },
  requireSql,
  transaction,
  isConfigured,
};
