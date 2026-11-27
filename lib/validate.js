// Field-level validation for the Route & Stop service.
//
// Every function returns a human-readable message when the value is wrong, or
// null when it is acceptable. The controller turns the first message it gets
// into 400 VALIDATION_ERROR, so the client always receives one clear problem
// to fix rather than a dump of everything that is wrong at once.
//
// These are pure functions on purpose: they have no database and no req/res,
// so tests/validate.test.js can exercise every rule without a server.

// Ids are no longer UUIDs. Ahmed's seed data uses readable keys such as
// "route-cairo-demo", so the rule is a character allow-list rather than a
// UUID shape: letters, digits, hyphen, underscore and colon, 1 to 128 long.
//
// An allow-list, not a block-list. Listing the characters that are safe is
// what makes this hold against inputs nobody thought of; a block-list only
// catches the attacks someone remembered. This rejects ' OR 1=1 (space and
// quote), {"$ne": null} (braces, quote, dollar), ../ and every other shape
// of injection, because none of those characters is on the list.
const ID_PATTERN = /^[A-Za-z0-9_:-]{1,128}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ROUTE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,19}$/;
const PLATE_PATTERN = /^[A-Z0-9؀-ۿ][A-Z0-9؀-ۿ -]{2,19}$/i;

const RUN_TYPES = new Set(['morning', 'afternoon']);
const TRIP_STATUSES = new Set(['active', 'cancelled']);

/** A trimmed string of a given length, or a message saying what is wrong. */
function text(value, label, min, max, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    return required ? `${label} is required.` : null;
  }
  if (typeof value !== 'string') {
    return `${label} must be text.`;
  }
  const length = value.trim().length;
  if (length < min || length > max) {
    return `${label} must contain between ${min} and ${max} characters.`;
  }
  return null;
}

function id(value, label) {
  // The type check comes first and matters as much as the pattern. A JSON
  // body can carry an object where an id is expected, and {"$ne": null}
  // passed straight through to a query is the NoSQL version of ' OR 1=1.
  // A non-string is refused here, before it can reach DynamoDB.
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    return `${label} must be an id made of letters, numbers, hyphen, underscore or colon.`;
  }
  return null;
}

/** Optional foreign key: absent is fine, present must be a valid id. */
function optionalId(value, label) {
  if (value === undefined || value === null || value === '') return null;
  return id(value, label);
}

function routeCode(value) {
  const problem = text(value, 'Route code', 2, 20);
  if (problem) return problem;
  if (!ROUTE_CODE_PATTERN.test(value.trim().toUpperCase())) {
    return 'Route code may contain only letters, numbers and hyphens, for example R-01.';
  }
  return null;
}

function plateNumber(value) {
  const problem = text(value, 'Plate number', 3, 20);
  if (problem) return problem;
  if (!PLATE_PATTERN.test(value.trim())) {
    return 'Plate number may contain only letters, numbers, spaces and hyphens.';
  }
  return null;
}

function runType(value) {
  if (!RUN_TYPES.has(value)) {
    return 'Run type must be morning or afternoon.';
  }
  return null;
}

function tripStatus(value) {
  if (!TRIP_STATUSES.has(value)) {
    return 'Status must be active or cancelled.';
  }
  return null;
}

/**
 * A calendar date written as YYYY-MM-DD.
 *
 * The pattern check alone is not enough: "2026-02-31" matches it but is not a
 * real day, and JavaScript would silently roll it over to 3 March. Building
 * the date and comparing it back catches that.
 */
function isoDate(value, label) {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) {
    return `${label} must be a date written as YYYY-MM-DD.`;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return `${label} is not a real date.`;
  }
  return null;
}

function positiveInteger(value, label, max = 1000) {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    return `${label} must be a whole number between 1 and ${max}.`;
  }
  return null;
}

/**
 * ISO day numbers: 1 = Monday ... 7 = Sunday. Used by route schedules, where
 * an Egyptian school week is typically [7, 1, 2, 3, 4] (Sunday to Thursday).
 */
function daysOfWeek(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 7) {
    return 'Days of week must be a list of 1 to 7 day numbers (1 = Monday, 7 = Sunday).';
  }
  const seen = new Set();
  for (const day of value) {
    if (!Number.isInteger(day) || day < 1 || day > 7) {
      return 'Each day of week must be a whole number from 1 (Monday) to 7 (Sunday).';
    }
    if (seen.has(day)) {
      return 'Days of week must not repeat.';
    }
    seen.add(day);
  }
  return null;
}

/** Runs checks in order and returns the first problem, or null. */
function first(...problems) {
  for (const problem of problems) {
    if (problem) return problem;
  }
  return null;
}

/**
 * Rejects a body that carries fields the server owns.
 *
 * The Lab 3 contract says the client never chooses id, status or timestamps.
 * Silently ignoring them is the usual approach, but telling the caller is more
 * useful during integration and makes the rule visible in the test plan.
 */
function rejectServerOwnedFields(body, fields) {
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      return `${field} is set by the server and cannot be sent by the client.`;
    }
  }
  return null;
}

module.exports = {
  ID_PATTERN,
  RUN_TYPES,
  TRIP_STATUSES,
  text,
  id,
  optionalId,
  routeCode,
  plateNumber,
  runType,
  tripStatus,
  isoDate,
  positiveInteger,
  daysOfWeek,
  first,
  rejectServerOwnedFields
};
