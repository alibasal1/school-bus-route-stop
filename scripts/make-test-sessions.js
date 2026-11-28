#!/usr/bin/env node
// Make a session for each test user, so the API can be tested before the
// login page is wired up.
//
//   node scripts/make-test-sessions.js
//
// The test users belong to Ahmed's auth service. This script does NOT
// create users: it only writes a Sessions item for each one, which is what
// the login endpoint will do later.
//
// How a session works here (the same as Ali's and Ahmed's auth.js):
//   * the token is 32 random bytes, hex
//   * the TABLE stores only its SHA-256 hash, as the item key
//   * the token itself is shown once, here, and written to a file git ignores
// So a dump of the Sessions table contains nothing anyone can log in with.

require('dotenv').config({ quiet: true });

const { randomBytes, createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const { TABLES, getItem, putItem } = require('../db/dynamo');

// Fixed ids, agreed with the team so all three services test against the
// same people.
const TEST_USERS = [
  { label: 'parent1', id: '11111111-1111-4111-8111-111111111111' },
  { label: 'parent2', id: '22222222-2222-4222-8222-222222222222' },
  { label: 'admin', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  { label: 'supervisor', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
];

const HOURS = 8;
const OUTPUT = path.join(__dirname, '..', '.test-tokens.local');

async function main() {
  const expiresAt = Math.floor(Date.now() / 1000) + HOURS * 3600;
  const lines = [
    `# Test tokens, made ${new Date().toISOString()}, valid ${HOURS} hours.`,
    '# Never commit this file.',
  ];

  for (const user of TEST_USERS) {
    // Check the user exists rather than creating one: these accounts belong
    // to the auth service, and inventing a user here would put a row in
    // someone else's table that their code knows nothing about.
    const existing = await getItem(TABLES.USERS, { id: user.id });
    if (!existing) {
      console.error(`${user.label}: no such user (${user.id}). Ask Ahmed to seed it. Skipped.`);
      continue;
    }

    const token = randomBytes(32).toString('hex');
    await putItem(TABLES.SESSIONS, {
      id: createHash('sha256').update(token, 'utf8').digest('hex'),
      user_id: user.id,
      expires_at: expiresAt,
      created_at: new Date().toISOString(),
    });

    console.log(`${user.label.padEnd(11)} role=${existing.role}`);
    lines.push(`${user.label.toUpperCase()}_TOKEN=${token}`);
  }

  fs.writeFileSync(OUTPUT, `${lines.join('\n')}\n`, { mode: 0o600 });
  console.log(`\nTokens written to ${path.basename(OUTPUT)} (git ignores it).`);
  console.log('Use one with:  Authorization: Bearer <token>');
}

main().catch((error) => {
  console.error('Failed:', error.message);
  process.exit(1);
});
