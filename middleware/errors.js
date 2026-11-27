// One error shape for the whole service.
//
// Lab 3 fixed the contract as { "error": { "code", "message" } } and every
// failure in this service uses it, including the ones Express raises itself
// (bad JSON, body too large) and the ones API Gateway would otherwise answer
// in its own format. A frontend that can read one failure can read them all.

/** Codes the API can return. Kept in one place so docs and code cannot drift. */
const CODES = {
  VALIDATION_ERROR: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  ROUTE_NOT_FOUND: 404,
  RESOURCE_NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  BOT_CHECK_FAILED: 403,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503
};

function sendError(res, status, code, message, details) {
  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  if (res.locals && res.locals.requestId) body.error.request_id = res.locals.requestId;
  return res.status(status).json(body);
}

/**
 * An error that is safe to show the caller.
 *
 * Anything thrown without `expose` is treated as a bug and answered with a
 * generic 500, so an internal message (a driver error naming a column, a
 * stack trace) can never leak through a path nobody thought about.
 */
class ApiError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = CODES[code] || 500;
    this.details = details;
    this.expose = true;
  }
}

const badRequest = (message, details) => new ApiError('VALIDATION_ERROR', message, details);
const notFound = (message = 'Not found.') => new ApiError('RESOURCE_NOT_FOUND', message);
const conflict = (message, details) => new ApiError('CONFLICT', message, details);
const forbidden = (message = 'You do not have permission.') => new ApiError('FORBIDDEN', message);

/**
 * Wraps an async handler so a rejected promise reaches the error handler.
 * Express 5 does this on its own; the wrapper is kept because it makes the
 * path of an error visible at every route, which the lab asks us to explain.
 */
function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/** Last route: the method and path matched nothing. */
function routeNotFound(req, res) {
  return sendError(
    res,
    404,
    'ROUTE_NOT_FOUND',
    `${req.method} ${req.path} is not an endpoint of this service.`
  );
}

/**
 * Final error handler. Four parameters, so Express recognises it as one.
 *
 * Client mistakes are named; everything else is logged in full on the server
 * and answered with a generic message. Nothing derived from an exception is
 * ever copied into the response body unless it was raised deliberately.
 */
function errorHandler(error, req, res, _next) {
  const requestId = res.locals.requestId;

  if (error.type === 'entity.parse.failed') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Request body is not valid JSON.');
  }
  if (error.type === 'entity.too.large') {
    return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
  }
  if (error instanceof ApiError || error.expose) {
    const code = error.code && CODES[error.code] ? error.code : 'VALIDATION_ERROR';
    return sendError(res, CODES[code], code, error.message, error.details);
  }
  // DynamoDB refusing the call is a configuration or permissions problem,
  // not something the caller did. The reason goes to the log; the caller
  // gets a 503 and the request id.
  if (
    error.name === 'ResourceNotFoundException' ||
    error.name === 'AccessDeniedException' ||
    error.name === 'UnrecognizedClientException' ||
    error.code === 'DB_NOT_CONFIGURED'
  ) {
    console.error(
      JSON.stringify({
        level: 'error',
        request_id: requestId,
        msg: 'database unavailable',
        error: error.name || error.code,
      })
    );
    return sendError(
      res,
      503,
      'SERVICE_UNAVAILABLE',
      'The service is not fully configured. Please try again later.'
    );
  }

  // Unexpected: log everything we have, tell the caller nothing but the id.
  console.error(
    JSON.stringify({
      level: 'error',
      request_id: requestId,
      method: req.method,
      path: req.path,
      msg: error.message,
      stack: error.stack
    })
  );
  return sendError(
    res,
    500,
    'INTERNAL_ERROR',
    'Something went wrong. Quote the request id if you report this.'
  );
}

module.exports = {
  CODES,
  ApiError,
  sendError,
  badRequest,
  notFound,
  conflict,
  forbidden,
  asyncHandler,
  routeNotFound,
  errorHandler
};
