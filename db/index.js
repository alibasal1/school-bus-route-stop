// Neon connection for the Route & Stop service.
//
// Values interpolated into sql`...${value}...` are sent as bind parameters,
// never as SQL text, so user input cannot change the shape of a query.
// Nothing in this service builds SQL by string concatenation.
const { neon } = require('@neondatabase/serverless');

const connectionString = (process.env.DATABASE_URL || '').trim();

if (!connectionString) {
  // Failing here, at startup, is better than failing on the first request
  // with a confusing driver error. /api/health still answers so a deploy
  // with a missing variable is easy to spot.
  console.error(
    '[route-stop] DATABASE_URL is not set. Copy .env.example to .env and ' +
      'paste the Neon connection string, or add it in the Vercel dashboard.'
  );
}

const sql = connectionString ? neon(connectionString) : null;

function requireSql() {
  if (!sql) {
    const error = new Error('DATABASE_URL is not configured.');
    error.code = 'DB_NOT_CONFIGURED';
    throw error;
  }
  return sql;
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

module.exports = {
  sql,
  requireSql,
  transaction,
  isConfigured: Boolean(sql)
};
