// The Express application for the Route & Stop service.
//
// Split from server.js so the same app object can be started three ways
// without the code changing: node server.js on a laptop, a Vercel Function
// in the cloud, and (Lab 7) an AWS Lambda behind API Gateway. Only the file
// that starts it differs.
//
// The order of app.use() below IS the request pipeline, and it is chosen:
//
//   1. request id      every later log line and error can be tied together
//   2. security headers set before anything can answer, including errors
//   3. logger           registered early so failed requests are logged too
//   4. CORS             answers preflight before any work is done
//   5. body parser      with a size cap
//   6. JSON check       415 for a body that is not JSON
//   7. routes           the actual endpoints
//   8. 404 fallback     nothing matched
//   9. error handler    last, so it catches everything above it

const express = require('express');
const cors = require('cors');

const { logger, requestContext } = require('./middleware/logger');
const { securityHeaders, requireJsonBody } = require('./middleware/security');
const { routeNotFound, errorHandler } = require('./middleware/errors');
const apiRoutes = require('./routes/routes');

const app = express();

// Vercel and API Gateway both sit in front of this app, so the client's real
// protocol and address arrive in X-Forwarded-* headers. Trusting exactly one
// hop means req.secure and req.ip are correct without trusting a header a
// client can set for itself.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.disable('etag');

app.use(requestContext);
app.use(securityHeaders);
app.use(logger);

// ---------------------------------------------------------------------------
// CORS
//
// An allow-list, never a wildcard. CORS does not protect the API itself
// (curl ignores it), but without it any site a parent visits could make
// their browser call this API with their session and read the answer.
// Origins come from the environment so the deployed frontend's address is
// configuration, not a code change.
// ---------------------------------------------------------------------------
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header: a server-to-server call or a tool like Postman.
      // There is no browser to protect, and the request still has to pass
      // authentication, so it is allowed through.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin.replace(/\/$/, ''))) return callback(null, true);

      console.warn(JSON.stringify({ level: 'warn', msg: 'CORS origin rejected', origin }));
      // Answer without the allow header rather than throwing: the browser
      // blocks the response, which is the correct outcome, and the caller
      // gets a clean refusal instead of a 500.
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Turnstile-Token'],
    exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'Retry-After'],
    maxAge: 600
  })
);

// 32kb is far more than the largest legitimate body here (a 200-stop reorder
// is about 8kb). Capping it stops a large upload from consuming a serverless
// function's memory and billed time before any handler sees it.
app.use(express.json({ limit: '32kb' }));
app.use(requireJsonBody);

// Opening the API address in a browser should explain what this is rather
// than looking like a broken deployment.
app.get('/', (req, res) => {
  res.status(200).json({
    service: 'school-bus-route-stop',
    owner: 'Yahia Wael (247330)',
    docs: '/docs/api-contract.md in the repository',
    endpoints: ['/api/health', '/api/ready', '/api/routes', '/api/trips']
  });
});

app.use('/api', apiRoutes);

app.use(routeNotFound);
app.use(errorHandler);

module.exports = app;
