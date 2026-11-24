#!/usr/bin/env node
// Makes a session for each test user, so the API can be tested before the
// login page exists.
//
//   node scripts/make-test-sessions.js
//
// The four test users were created by Ali and already exist in Neon. This
// script does NOT create users: it only inserts a row in `sessions` for
// each one, which is the same thing the login endpoint will do later.
//
// How a session works here (the same as Ali's middleware/auth.js):
//   * the token is 32 random bytes, hex
//   * the DATABASE stores only its SHA-256 hash, never the token
//   * the token is shown once, here, and written to a file that git ignores
// So a leaked database backup contains nothing anyone can log in with, and
// a token that is lost cannot be recovered - a new one is made instead.

require('dotenv').config({ quiet: true });

const { randomBytes, createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const { requireSql } = require('../db');

// Fixed ids, agreed with Ali so both services test against the same people.
const TEST_USERS = [
  { label: 'parent1', id: '11111111-1111-4111-8111-111111111111' },
  { label: 'parent2', id: '22222222-2222-4222-8222-222222222222' },
  { label: 'admin', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  { label: 'supervisor', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
];

const HOURS = 8;
const OUTPUT = path.join(__dirname, '..', '.test-tokens.local');

async function main() {
  const sql = requireSql();
  const expiresAt = new Date(Date.now() + HOURS * 60 * 60 * 1000);
  const lines = [`# Test tokens, made ${new Date().toISOString()}, valid ${HOURS} hours.`, '# Never commit this file.'];

  for (const user of TEST_USERS) {
    // Check the user exists rather than creating one: these accounts belong
    // to the auth service, and inventing a user here would put a row in
    // someone else's table that their code knows nothing about.
    const rows = await sql`SELECT id, role FROM users WHERE id = ${user.id} LIMIT 1`;
    if (!rows[0]) {
      console.error(`${user.label}: no such user in Neon (${user.id}). Ask Ali to create it. Skipped.`);
      continue;
    }

    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');

    await sql`
      INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (${user.id}, ${tokenHash}, ${expiresAt.toISOString()})`;

    console.log(`${user.label.padEnd(11)} role=${rows[0].role}`);
    lines.push(`${user.label.toUpperCase()}_TOKEN=${token}`);
  }

  fs.writeFileSync(OUTPUT, `${lines.join('\n')}\n`, { mode: 0o600 });
  console.log(`\nTokens written to ${path.basename(OUTPUT)} (git ignores it).`);
  console.log('Use one with:  Authorization: Bearer <token>');
}

main().catch((error) => {
  // Print the message only. A driver error can carry the connection string.
  console.error('Failed:', error.message);
  process.exit(1);
});
