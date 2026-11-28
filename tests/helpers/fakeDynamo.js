// An in-memory stand-in for db/dynamo.js.
//
// The API tests need a database that behaves like DynamoDB without needing
// Floci running, so they can be part of `npm test` and run in a second. This
// fake implements the same functions db/dynamo.js exports, over plain Maps.
//
// It is deliberately small, and it is NOT DynamoDB. It supports exactly the
// expressions this service actually uses, and throws on anything else rather
// than quietly doing the wrong thing. A fake that silently ignores a
// ConditionExpression would make the double-cancel test pass for the wrong
// reason, which is worse than having no test.

const { TABLES, INDEXES } = require('../../db/dynamo');

class ConditionalCheckFailedException extends Error {
  constructor() {
    super('The conditional request failed');
    this.name = 'ConditionalCheckFailedException';
  }
}

/** Items are keyed by their key attributes joined together. */
function keyOf(key) {
  return Object.keys(key)
    .sort()
    .map((name) => `${name}=${key[name]}`)
    .join('|');
}

function resolveName(token, names = {}) {
  return token.startsWith('#') ? names[token] : token;
}

/**
 * Supports the two shapes this service uses:
 *   attribute_exists(id) / attribute_not_exists(id)
 *   #status = :active
 */
function conditionHolds(item, expression, names = {}, values = {}) {
  if (!expression) return true;
  const trimmed = expression.trim();

  const exists = trimmed.match(/^attribute_exists\((.+)\)$/);
  if (exists) return item !== undefined && item[resolveName(exists[1].trim(), names)] !== undefined;

  const notExists = trimmed.match(/^attribute_not_exists\((.+)\)$/);
  if (notExists) return item === undefined || item[resolveName(notExists[1].trim(), names)] === undefined;

  const equals = trimmed.match(/^(\S+)\s*=\s*(:\S+)$/);
  if (equals) {
    if (!item) return false;
    return item[resolveName(equals[1], names)] === values[equals[2]];
  }

  throw new Error(`fakeDynamo: unsupported ConditionExpression "${expression}"`);
}

/**
 * Supports `SET a = :x, #b = :y` and the one counter form events.js uses,
 * `SET attempts = if_not_exists(attempts, :zero) + :one`.
 */
function applyUpdate(item, expression, names = {}, values = {}) {
  const match = expression.trim().match(/^SET\s+(.+)$/i);
  if (!match) throw new Error(`fakeDynamo: unsupported UpdateExpression "${expression}"`);

  const next = { ...item };
  // Split on commas that are not inside brackets.
  for (const clause of match[1].split(/,(?![^(]*\))/)) {
    const [rawTarget, rawValue] = clause.split('=').map((part) => part.trim());
    const target = resolveName(rawTarget, names);

    const counter = rawValue.match(/^if_not_exists\((\S+),\s*(:\S+)\)\s*\+\s*(:\S+)$/);
    if (counter) {
      const current = next[resolveName(counter[1], names)] ?? values[counter[2]];
      next[target] = Number(current) + Number(values[counter[3]]);
      continue;
    }
    if (!rawValue.startsWith(':')) {
      throw new Error(`fakeDynamo: unsupported update value "${rawValue}"`);
    }
    next[target] = values[rawValue];
  }
  return next;
}

/** `#name = :value` or `name = :value`. */
function matchesSingleCondition(item, expression, names = {}, values = {}) {
  const parsed = expression.trim().match(/^(\S+)\s*=\s*(:\S+)$/);
  if (!parsed) throw new Error(`fakeDynamo: unsupported expression "${expression}"`);
  return item[resolveName(parsed[1], names)] === values[parsed[2]];
}

/**
 * @param {object} seed  table name -> array of items, e.g. { Routes: [...] }
 */
function createFakeDynamo(seed = {}) {
  const tables = new Map();

  function table(name) {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  }

  // Seeding uses the same key rules as the real tables.
  const keyFields = {
    [TABLES.USERS]: ['id'],
    [TABLES.SESSIONS]: ['id'],
    [TABLES.TRIP_STOPS]: ['trip_id', 'stop_id'],
    [TABLES.EVENTS]: ['event_id'],
  };
  const keyFor = (name, item) =>
    keyOf(Object.fromEntries((keyFields[name] || ['id']).map((field) => [field, item[field]])));

  for (const [name, items] of Object.entries(seed)) {
    for (const item of items) table(name).set(keyFor(name, item), { ...item });
  }

  const api = {
    TABLES,
    INDEXES,

    async getItem(name, key) {
      return table(name).get(keyOf(key)) ?? null;
    },

    async putItem(name, item, options = {}) {
      const key = keyFor(name, item);
      const existing = table(name).get(key);
      if (!conditionHolds(existing, options.ConditionExpression)) {
        throw new ConditionalCheckFailedException();
      }
      table(name).set(key, { ...item });
      return item;
    },

    async updateItem(name, key, options) {
      const id = keyOf(key);
      const existing = table(name).get(id);
      if (
        !conditionHolds(
          existing,
          options.ConditionExpression,
          options.ExpressionAttributeNames,
          options.ExpressionAttributeValues
        )
      ) {
        throw new ConditionalCheckFailedException();
      }
      const updated = applyUpdate(
        existing ?? { ...key },
        options.UpdateExpression,
        options.ExpressionAttributeNames,
        options.ExpressionAttributeValues
      );
      table(name).set(id, updated);
      return updated;
    },

    async deleteItem(name, key, options = {}) {
      const id = keyOf(key);
      if (!conditionHolds(table(name).get(id), options.ConditionExpression)) {
        throw new ConditionalCheckFailedException();
      }
      table(name).delete(id);
    },

    async queryAll(params) {
      return [...table(params.TableName).values()].filter((item) =>
        matchesSingleCondition(
          item,
          params.KeyConditionExpression,
          params.ExpressionAttributeNames,
          params.ExpressionAttributeValues
        )
      );
    },

    async scanAll(params) {
      const items = [...table(params.TableName).values()];
      if (!params.FilterExpression) return items;
      return items.filter((item) =>
        matchesSingleCondition(
          item,
          params.FilterExpression,
          params.ExpressionAttributeNames,
          params.ExpressionAttributeValues
        )
      );
    },

    /**
     * All-or-nothing, like the real thing: every condition is checked before
     * anything is written, and a failure leaves the tables untouched. The
     * stop-reorder test depends on this being true.
     */
    async transactWrite(items) {
      if (!items || items.length === 0) return;
      if (items.length > 100) throw new Error('fakeDynamo: transaction limit is 100 items');

      const planned = [];
      for (const entry of items) {
        if (entry.Put) {
          const { TableName, Item, ConditionExpression } = entry.Put;
          const key = keyFor(TableName, Item);
          if (!conditionHolds(table(TableName).get(key), ConditionExpression)) {
            throw new ConditionalCheckFailedException();
          }
          planned.push(() => table(TableName).set(key, { ...Item }));
        } else if (entry.Update) {
          const { TableName, Key, UpdateExpression, ConditionExpression } = entry.Update;
          const names = entry.Update.ExpressionAttributeNames;
          const values = entry.Update.ExpressionAttributeValues;
          const key = keyOf(Key);
          const existing = table(TableName).get(key);
          if (!conditionHolds(existing, ConditionExpression, names, values)) {
            throw new ConditionalCheckFailedException();
          }
          const updated = applyUpdate(existing ?? { ...Key }, UpdateExpression, names, values);
          planned.push(() => table(TableName).set(key, updated));
        } else if (entry.Delete) {
          const { TableName, Key, ConditionExpression } = entry.Delete;
          const key = keyOf(Key);
          if (!conditionHolds(table(TableName).get(key), ConditionExpression)) {
            throw new ConditionalCheckFailedException();
          }
          planned.push(() => table(TableName).delete(key));
        }
      }
      for (const apply of planned) apply();
    },

    async batchWrite(name, requests) {
      for (const request of requests) {
        if (request.PutRequest) {
          table(name).set(keyFor(name, request.PutRequest.Item), { ...request.PutRequest.Item });
        } else if (request.DeleteRequest) {
          table(name).delete(keyOf(request.DeleteRequest.Key));
        }
      }
    },

    async ping() {
      return true;
    },

    // --- helpers for assertions in the tests ---
    __items(name) {
      return [...table(name).values()];
    },
    __reset() {
      tables.clear();
    },
  };

  return api;
}

module.exports = { createFakeDynamo, ConditionalCheckFailedException, keyOf };
