// Calendar helpers for trip generation.
//
// Every date in this service is a plain calendar day written as YYYY-MM-DD.
// Trips belong to a school day, not to an instant in time: a trip on
// 2026-03-01 is the same trip whether the server runs in Cairo or in
// Washington. All arithmetic therefore happens in UTC, so a server in a
// different timezone can never shift a trip onto the wrong day.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toUtcDate(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`);
}

function toIso(date) {
  return date.toISOString().slice(0, 10);
}

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
function isoDayOfWeek(isoDate) {
  const day = toUtcDate(isoDate).getUTCDay(); // 0 = Sunday
  return day === 0 ? 7 : day;
}

function addDays(isoDate, days) {
  return toIso(new Date(toUtcDate(isoDate).getTime() + days * MS_PER_DAY));
}

/** Whole days from `from` to `to`, inclusive of both ends. */
function daysBetween(from, to) {
  return Math.round((toUtcDate(to).getTime() - toUtcDate(from).getTime()) / MS_PER_DAY);
}

/** Every calendar day from `from` to `to` inclusive, in order. */
function eachDate(from, to) {
  const dates = [];
  const span = daysBetween(from, to);
  for (let offset = 0; offset <= span; offset += 1) {
    dates.push(addDays(from, offset));
  }
  return dates;
}

/** Today in UTC, as YYYY-MM-DD. */
function today() {
  return toIso(new Date());
}

/** True when `date` falls inside a schedule window (active_to may be null). */
function withinWindow(date, activeFrom, activeTo) {
  if (date < activeFrom) return false;
  if (activeTo && date > activeTo) return false;
  return true;
}

module.exports = {
  MS_PER_DAY,
  toIso,
  isoDayOfWeek,
  addDays,
  daysBetween,
  eachDate,
  today,
  withinWindow
};
