// Stop ordering.
//
// stop_order is a contract, not a free-text field: the Schedule & Arrival
// service walks the stops in order to lay out arrival windows, and the parent
// app shows "your stop is 4th". So the sequence must always be 1..n with no
// gaps, no repeats and no stop from another route mixed in.
//
// Letting the client PUT its own numbers one stop at a time breaks that in
// three ways: a dropped request leaves a gap, two admins editing at once
// produce duplicates, and a typo can silently push a stop to position 99.
// Instead the client says what the order should be, and this module works out
// the smallest set of changes that gets there. The caller applies them in one
// transaction against a DEFERRABLE unique constraint, so the sequence is
// never invalid, not even halfway through the update.

/** Thrown for a request that cannot produce a valid sequence. */
function invalid(message, code = 'VALIDATION_ERROR') {
  return Object.assign(new Error(message), { code, expose: true });
}

/**
 * Turn a complete desired ordering into the rows that actually change.
 *
 * @param {Array<{id: string, stop_order: number}>} currentStops stops of one route
 * @param {string[]} orderedIds every stop id of that route, in the new order
 * @returns {Array<{id: string, stop_order: number}>} only the stops that move
 */
function planFullOrder(currentStops, orderedIds) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    throw invalid('Send the full list of stop ids in the order you want.');
  }

  const currentById = new Map(currentStops.map((stop) => [stop.id, stop]));

  if (orderedIds.length !== currentStops.length) {
    throw invalid(
      `The list must contain every stop on this route exactly once: expected ${currentStops.length} ids, received ${orderedIds.length}.`
    );
  }

  const seen = new Set();
  for (const id of orderedIds) {
    if (seen.has(id)) {
      throw invalid('The list must not contain the same stop twice.');
    }
    if (!currentById.has(id)) {
      // Either a stop from a different route, or one that was deleted while
      // the admin had the page open. Both are a 400, not a silent reorder of
      // whatever happens to match.
      throw invalid('The list contains a stop that is not on this route.');
    }
    seen.add(id);
  }

  const changes = [];
  orderedIds.forEach((id, index) => {
    const position = index + 1;
    if (currentById.get(id).stop_order !== position) {
      changes.push({ id, stop_order: position });
    }
  });
  return changes;
}

/**
 * Move one stop to a new position, keeping the others in their relative order.
 * A convenience over planFullOrder for the common "drag one stop" action.
 */
function planMove(currentStops, stopId, toPosition) {
  const ordered = [...currentStops].sort((a, b) => a.stop_order - b.stop_order);
  const fromIndex = ordered.findIndex((stop) => stop.id === stopId);
  if (fromIndex === -1) {
    throw invalid('That stop is not on this route.');
  }
  if (!Number.isInteger(toPosition) || toPosition < 1 || toPosition > ordered.length) {
    throw invalid(`Position must be a whole number between 1 and ${ordered.length}.`);
  }

  const ids = ordered.map((stop) => stop.id);
  const [moved] = ids.splice(fromIndex, 1);
  ids.splice(toPosition - 1, 0, moved);
  return planFullOrder(currentStops, ids);
}

/**
 * Close the gap left by a deleted stop.
 *
 * Deleting stop 2 of 5 must leave 1,2,3,4 and not 1,3,4,5: the gap would make
 * "4th stop" mean different things in different parts of the app.
 */
function planAfterDelete(currentStops, deletedId) {
  const remaining = currentStops
    .filter((stop) => stop.id !== deletedId)
    .sort((a, b) => a.stop_order - b.stop_order);

  const changes = [];
  remaining.forEach((stop, index) => {
    const position = index + 1;
    if (stop.stop_order !== position) {
      changes.push({ id: stop.id, stop_order: position });
    }
  });
  return changes;
}

/** The position a newly appended stop should take. */
function nextPosition(currentStops) {
  return currentStops.reduce((max, stop) => Math.max(max, stop.stop_order), 0) + 1;
}

/** True when the stored sequence is exactly 1..n. Used by the readiness check. */
function isContiguous(currentStops) {
  const orders = currentStops.map((stop) => stop.stop_order).sort((a, b) => a - b);
  return orders.every((order, index) => order === index + 1);
}

module.exports = {
  planFullOrder,
  planMove,
  planAfterDelete,
  nextPosition,
  isContiguous
};
