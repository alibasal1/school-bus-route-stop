// Tests for stop ordering.
//
// The invariant under test is that stop_order is always 1..n with no gaps and
// no repeats, whatever the admin does. Every case below is one way that can
// break.

const test = require('node:test');
const assert = require('node:assert/strict');

const { planFullOrder, planMove, planAfterDelete, nextPosition, isContiguous } =
  require('../lib/resequence');

const stops = [
  { id: 'a', stop_order: 1 },
  { id: 'b', stop_order: 2 },
  { id: 'c', stop_order: 3 },
  { id: 'd', stop_order: 4 }
];

test('returns only the stops that actually move', () => {
  // a and b keep their places, so writing them would be pointless work and
  // would touch rows another admin might be reading.
  const changes = planFullOrder(stops, ['a', 'b', 'd', 'c']);
  assert.deepEqual(changes, [
    { id: 'd', stop_order: 3 },
    { id: 'c', stop_order: 4 }
  ]);
});

test('an unchanged order produces no writes at all', () => {
  assert.deepEqual(planFullOrder(stops, ['a', 'b', 'c', 'd']), []);
});

test('a full reversal renumbers every stop', () => {
  const changes = planFullOrder(stops, ['d', 'c', 'b', 'a']);
  assert.equal(changes.length, 4);
  assert.deepEqual(
    changes.map((change) => change.stop_order).sort(),
    [1, 2, 3, 4]
  );
});

test('rejects a partial list', () => {
  assert.throws(() => planFullOrder(stops, ['a', 'b']), /every stop on this route/);
});

test('rejects a duplicated stop', () => {
  assert.throws(() => planFullOrder(stops, ['a', 'b', 'c', 'c']), /same stop twice/);
});

test('rejects a stop from another route', () => {
  assert.throws(() => planFullOrder(stops, ['a', 'b', 'c', 'zzz']), /not on this route/);
});

test('rejects an empty list', () => {
  assert.throws(() => planFullOrder(stops, []), /full list/);
});

test('moving a stop forward keeps everyone else in order', () => {
  // a,b,c,d -> move a to position 3 -> b,c,a,d
  const changes = planMove(stops, 'a', 3);
  const resulting = applyChanges(stops, changes);
  assert.deepEqual(order(resulting), ['b', 'c', 'a', 'd']);
});

test('moving a stop backward keeps everyone else in order', () => {
  const changes = planMove(stops, 'd', 1);
  assert.deepEqual(order(applyChanges(stops, changes)), ['d', 'a', 'b', 'c']);
});

test('moving a stop to where it already is changes nothing', () => {
  assert.deepEqual(planMove(stops, 'b', 2), []);
});

test('rejects a move outside the route', () => {
  assert.throws(() => planMove(stops, 'a', 9), /between 1 and 4/);
  assert.throws(() => planMove(stops, 'a', 0), /between 1 and 4/);
  assert.throws(() => planMove(stops, 'zzz', 1), /not on this route/);
});

test('deleting a middle stop closes the gap', () => {
  // Without this, deleting b leaves 1,3,4 and "the third stop" becomes
  // ambiguous between the apps that read it.
  const changes = planAfterDelete(stops, 'b');
  assert.deepEqual(changes, [
    { id: 'c', stop_order: 2 },
    { id: 'd', stop_order: 3 }
  ]);
});

test('deleting the last stop needs no renumbering', () => {
  assert.deepEqual(planAfterDelete(stops, 'd'), []);
});

test('deleting the only stop leaves an empty route', () => {
  assert.deepEqual(planAfterDelete([{ id: 'a', stop_order: 1 }], 'a'), []);
});

test('a new stop is appended after the last one', () => {
  assert.equal(nextPosition(stops), 5);
  assert.equal(nextPosition([]), 1);
});

test('isContiguous spots a broken sequence', () => {
  assert.ok(isContiguous(stops));
  assert.ok(!isContiguous([{ id: 'a', stop_order: 1 }, { id: 'b', stop_order: 3 }]));
});

// --- helpers ---------------------------------------------------------------

function applyChanges(current, changes) {
  const byId = new Map(changes.map((change) => [change.id, change.stop_order]));
  return current.map((stop) => ({ ...stop, stop_order: byId.get(stop.id) ?? stop.stop_order }));
}

function order(list) {
  return [...list].sort((a, b) => a.stop_order - b.stop_order).map((stop) => stop.id);
}
