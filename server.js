// Local entry point for the Route & Stop service.
//
// Everything that defines the API lives in app.js. This file only starts a
// listener, which is what separates "running on a laptop" from "running as a
// Vercel Function". Vercel imports the exported app; nothing here runs there.
require('dotenv').config({ quiet: true });

const app = require('./app');

const PORT = Number(process.env.PORT) || 3001;

const server = app.listen(PORT, () => {
  console.log(
    JSON.stringify({
      level: 'info',
      service: 'route-stop',
      msg: `Route & Stop API listening on http://localhost:${PORT}`,
      environment: process.env.NODE_ENV || 'development',
      database: process.env.DATABASE_URL ? 'configured' : 'MISSING',
      rate_limiter: process.env.UPSTASH_REDIS_REST_URL ? 'upstash' : 'in-memory (development)',
      turnstile: process.env.TURNSTILE_SECRET_KEY ? 'enabled' : 'disabled'
    })
  );
});

// Finish in-flight requests before exiting, so a deploy or a Ctrl+C never
// cuts off a cancellation halfway through writing its event.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(JSON.stringify({ level: 'info', msg: `${signal} received, shutting down` }));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}

module.exports = app;
