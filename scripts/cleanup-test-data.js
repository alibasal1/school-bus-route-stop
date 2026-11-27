#!/usr/bin/env node
// Remove the demo data this service created.
//
//   npm run cleanup            show what would go
//   npm run cleanup -- --yes   actually delete
//
// Deletes only items carrying demo: true, and only from the tables this
// service owns. It never touches Users or Sessions, which belong to Ahmed,
// and never touches anything Ali owns.
//
// A dry run by default, because a cleanup script that deletes on sight is
// one mistyped table name away from clearing the team's database the night
// before the demo.

require('dotenv').config({ quiet: true });

const { TABLES, scanAll, deleteItem } = require('../db/dynamo');

const CONFIRMED = process.argv.includes('--yes');

// Table and the name of its key attribute. Users and Sessions are
// deliberately absent: this service may read them and nothing more.
const OWNED = [
  { table: TABLES.ROUTES, key: 'id' },
  { table: TABLES.STOPS, key: 'id' },
  { table: TABLES.BUSES, key: 'id' },
  { table: TABLES.SCHEDULES, key: 'id' },
  { table: TABLES.TRIPS, key: 'id' },
  { table: TABLES.EVENTS, key: 'event_id' },
];

async function main() {
  console.log(CONFIRMED ? 'Deleting demo data.' : 'Dry run. Add --yes to delete.');

  let total = 0;
  for (const { table, key } of OWNED) {
    let items;
    try {
      items = await scanAll({
        TableName: table,
        FilterExpression: 'demo = :yes',
        ExpressionAttributeValues: { ':yes': true },
      });
    } catch (error) {
      console.log(`  ${table}: skipped (${error.name || error.message})`);
      continue;
    }

    console.log(`  ${table}: ${items.length} demo item(s)`);
    total += items.length;

    if (CONFIRMED) {
      for (const item of items) {
        await deleteItem(table, { [key]: item[key] });
      }
    }
  }

  console.log(
    CONFIRMED ? `\nDeleted ${total} item(s).` : `\n${total} item(s) would be deleted. Run again with --yes.`
  );
}

main().catch((error) => {
  console.error('Cleanup failed:', error.message);
  process.exit(1);
});
