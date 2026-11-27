// Tests for the validation rules and the date helpers.
//
// These are the checks that stand on the trust boundary, so the negative
// cases matter more than the positive ones: each one is a request that must
// not reach the database.

const test = require('node:test');
const assert = require('node:assert/strict');

const validate = require('../../lib/validate');
const dates = require('../../lib/dates');

test('text enforces the length rules from the data dictionary', () => {
  assert.equal(validate.text('Maadi Line', 'Route name', 3, 100), null);
  assert.match(validate.text('ab', 'Route name', 3, 100), /between 3 and 100/);
  assert.match(validate.text('x'.repeat(101), 'Route name', 3, 100), /between 3 and 100/);
});

test('text rejects whitespace-only input', () => {
  // '   ' has length 3 but is not a name. Trimming before measuring is what
  // stops a blank stop appearing in the parent's app.
  assert.match(validate.text('   ', 'Stop name', 3, 100), /between 3 and 100/);
});

test('text rejects a non-string where a string is required', () => {
  // Without this, the service would later call .trim() on a number and
  // produce a 500 for what is really a 400.
  assert.match(validate.text(42, 'Route name', 3, 100), /must be text/);
  assert.match(validate.text({}, 'Route name', 3, 100), /must be text/);
  assert.match(validate.text(undefined, 'Route name', 3, 100), /is required/);
});

test('optional text may be absent but must still be valid when present', () => {
  assert.equal(validate.text(undefined, 'Landmark', 3, 150, { required: false }), null);
  assert.match(validate.text('ab', 'Landmark', 3, 150, { required: false }), /between 3 and 150/);
});

test('id accepts the readable keys the team actually uses', () => {
  // Ahmed's seed data, not UUIDs.
  assert.equal(validate.id('route-cairo-demo', 'Route id'), null);
  assert.equal(validate.id('trip:route-cairo-demo:morning', 'Route id'), null);
  assert.equal(validate.id('11111111-1111-4111-8111-111111111111', 'Route id'), null);
  assert.equal(validate.id('Stop_01', 'Stop id'), null);
});

test('id blocks SQL and NoSQL injection', () => {
  // The allow-list has no space, quote, brace or dollar, so none of these
  // can get through to a query.
  assert.match(validate.id("1' OR '1'='1", 'Route id'), /letters, numbers/);
  assert.match(validate.id("' OR 1=1 --", 'Route id'), /letters, numbers/);
  assert.match(validate.id('{"$ne": null}', 'Route id'), /letters, numbers/);
  assert.match(validate.id('../../etc/passwd', 'Route id'), /letters, numbers/);
  assert.match(validate.id('a'.repeat(129), 'Route id'), /letters, numbers/);
  assert.match(validate.id('', 'Route id'), /letters, numbers/);
});

test('id rejects a non-string, which is how NoSQL injection usually arrives', () => {
  // A JSON body can carry an object where an id is expected. Passing
  // {"$ne": null} straight to a query is the NoSQL version of ' OR 1=1, so
  // the type check matters as much as the pattern.
  assert.match(validate.id({ $ne: null }, 'Route id'), /letters, numbers/);
  assert.match(validate.id(['route-1'], 'Route id'), /letters, numbers/);
  assert.match(validate.id(42, 'Route id'), /letters, numbers/);
  assert.match(validate.id(undefined, 'Route id'), /letters, numbers/);
  assert.match(validate.id(null, 'Route id'), /letters, numbers/);
});

test('optionalId allows absent but still checks a value', () => {
  assert.equal(validate.optionalId(undefined, 'Bus id'), null);
  assert.equal(validate.optionalId('', 'Bus id'), null);
  assert.equal(validate.optionalId('bus-01', 'Bus id'), null);
  assert.match(validate.optionalId('bus 01', 'Bus id'), /letters, numbers/);
});

test('route code accepts the house format and rejects punctuation', () => {
  assert.equal(validate.routeCode('R-01'), null);
  assert.equal(validate.routeCode('r-01'), null); // normalised to upper case later
  assert.match(validate.routeCode('R 01;DROP'), /only letters, numbers and hyphens/);
});

test('isoDate rejects a date that looks right but does not exist', () => {
  assert.equal(validate.isoDate('2026-03-01', 'service_date'), null);
  assert.match(validate.isoDate('2026-02-31', 'service_date'), /not a real date/);
  assert.match(validate.isoDate('01-03-2026', 'service_date'), /YYYY-MM-DD/);
  assert.match(validate.isoDate('2026-3-1', 'service_date'), /YYYY-MM-DD/);
});

test('isoDate accepts a real leap day and rejects a fake one', () => {
  assert.equal(validate.isoDate('2028-02-29', 'date'), null);
  assert.match(validate.isoDate('2027-02-29', 'date'), /not a real date/);
});

test('run type and status are closed sets', () => {
  assert.equal(validate.runType('morning'), null);
  assert.match(validate.runType('evening'), /morning or afternoon/);
  assert.equal(validate.tripStatus('cancelled'), null);
  assert.match(validate.tripStatus('deleted'), /active or cancelled/);
});

test('days of week must be unique ISO day numbers', () => {
  assert.equal(validate.daysOfWeek([7, 1, 2, 3, 4]), null);
  assert.match(validate.daysOfWeek([1, 1]), /must not repeat/);
  assert.match(validate.daysOfWeek([0]), /from 1 \(Monday\) to 7 \(Sunday\)/);
  assert.match(validate.daysOfWeek([8]), /from 1 \(Monday\) to 7 \(Sunday\)/);
  assert.match(validate.daysOfWeek([]), /list of 1 to 7/);
  assert.match(validate.daysOfWeek('monday'), /list of 1 to 7/);
});

test('server-owned fields are refused', () => {
  // The Lab 3 contract: the client never chooses the id, the status or the
  // timestamps, even if it sends them.
  assert.match(
    validate.rejectServerOwnedFields({ id: 'HACKED-1', name: 'x' }, ['id', 'status']),
    /set by the server/
  );
  assert.equal(validate.rejectServerOwnedFields({ name: 'x' }, ['id', 'status']), null);
});

test('first returns the earliest problem only', () => {
  assert.equal(validate.first(null, null), null);
  assert.equal(validate.first(null, 'second problem', 'third'), 'second problem');
});

// --- dates ------------------------------------------------------------------

test('isoDayOfWeek uses ISO numbering', () => {
  assert.equal(dates.isoDayOfWeek('2026-03-01'), 7); // Sunday
  assert.equal(dates.isoDayOfWeek('2026-03-02'), 1); // Monday
  assert.equal(dates.isoDayOfWeek('2026-03-07'), 6); // Saturday
});

test('date arithmetic crosses month and year boundaries', () => {
  assert.equal(dates.addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(dates.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(dates.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(dates.addDays('2026-03-01', -1), '2026-02-28');
});

test('eachDate is inclusive at both ends', () => {
  assert.deepEqual(dates.eachDate('2026-03-01', '2026-03-03'), [
    '2026-03-01',
    '2026-03-02',
    '2026-03-03'
  ]);
  assert.deepEqual(dates.eachDate('2026-03-01', '2026-03-01'), ['2026-03-01']);
});

test('daysBetween is not thrown off by a daylight-saving change', () => {
  // Egypt moves its clocks in late April. Working in UTC means the count
  // stays whole days instead of coming out as 29.958.
  assert.equal(dates.daysBetween('2026-04-20', '2026-05-20'), 30);
});

test('withinWindow treats a missing end date as open-ended', () => {
  assert.ok(dates.withinWindow('2026-06-01', '2026-01-01', null));
  assert.ok(!dates.withinWindow('2025-12-31', '2026-01-01', null));
  assert.ok(!dates.withinWindow('2026-06-01', '2026-01-01', '2026-05-31'));
});
