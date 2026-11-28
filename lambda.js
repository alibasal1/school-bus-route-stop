// AWS Lambda entry point for the Route & Stop API.
//
// Three ways to start the same app, and only the starter differs:
//   server.js   a PC, port 3001
//   lambda.js   this file: Lambda behind API Gateway (Floci and real AWS)
//   app.js      the app itself, which never listens and never calls AWS
//
// Keeping app.js free of anything Lambda-specific is what lets the tests and
// `npm run dev` run with no AWS at all.

const serverlessHttp = require('serverless-http');
const app = require('./app');
const { loadSecrets } = require('./config/secrets');

const serverlessHandler = serverlessHttp(app, {
  request(request, event) {
    // --- the JSON body fix ------------------------------------------------
    // serverless-http hands Express the body as a Buffer. Express 5 then
    // leaves req.body as that Buffer instead of a parsed object, so every
    // field reads as undefined and every POST and PATCH comes back 400
    // "code is required". Turning it into a string here, before Express
    // sees it, lets express.json() parse it normally.
    if (Buffer.isBuffer(request.body)) {
      request.body = request.body.toString('utf8');
    }
    // API Gateway sends a binary body base64-encoded. Decoding it here keeps
    // the same path working for both.
    if (event && event.isBase64Encoded && typeof request.body === 'string') {
      request.body = Buffer.from(request.body, 'base64').toString('utf8');
    }
    // A string is still not an object: express.json() does not parse a body
    // that is already set, so every POST, PUT and PATCH answered 400 "Request
    // body must be a JSON object." on Lambda. Parse JSON here. A body that is
    // not valid JSON becomes undefined, and the controller answers 400.
    if (typeof request.body === 'string') {
      const type = String(request.headers['content-type'] || '').toLowerCase();
      const text = request.body;
      request.body = undefined;
      if (type.includes('application/json') && text) {
        try {
          request.body = JSON.parse(text);
        } catch {
          request.body = undefined;
        }
      }
    }

    // --- the real client address -----------------------------------------
    // The rate limiter must not trust X-Forwarded-For: a client can set that
    // header to anything and get a fresh budget on every request. API
    // Gateway reports the address it actually accepted the connection from,
    // in the event, where no client can reach it. Attaching the event here
    // is how middleware/rateLimit.js gets at it.
    request.awsEvent = event;
  },
});

exports.handler = async (event, context) => {
  // Lambda reuses a container between invocations, so this costs one call
  // on a cold start and nothing afterwards.
  context.callbackWaitsForEmptyEventLoop = false;
  await loadSecrets();
  return serverlessHandler(event, context);
};
