#!/usr/bin/env node
// Builds the Lambda deployment package: dist/route-stop-api.zip
//
//   npm run zip
//
// The zip is written by this file rather than by calling the `zip` command,
// for three reasons:
//   * `zip` is not installed on every machine, and Windows has no built-in
//     equivalent that behaves the same way;
//   * no shell is involved, so a folder with a space in its name ("Cloud
//     Computing Project") just works, with no quoting to get wrong;
//   * it can decide what goes in, so .env can never be included by accident.
//
// What goes in: the application files, and node_modules without the
// development packages. What stays out: .env and anything like it, .git,
// tests, docs, infra, the dist folder itself.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT_FILE = path.join(OUT_DIR, 'route-stop-api.zip');

// Everything the function needs at run time, and nothing else.
const INCLUDE_FILES = ['lambda.js', 'app.js', 'package.json'];
const INCLUDE_DIRS = ['routes', 'controllers', 'services', 'middleware', 'lib', 'db', 'config'];

// Checked against every path, at every depth. The .env rules are the
// important ones: a secret in the zip is a secret uploaded to AWS and
// readable by anyone who can download the function.
const NEVER = [
  /(^|[\\/])\.env($|\.)/i,
  /(^|[\\/])\.git($|[\\/])/,
  /(^|[\\/])dist([\\/]|$)/,
  /(^|[\\/])tests?([\\/]|$)/,
  /(^|[\\/])docs([\\/]|$)/,
  /(^|[\\/])infra([\\/]|$)/,
  /(^|[\\/])scripts([\\/]|$)/,
  /(^|[\\/])loadtest([\\/]|$)/,
  /\.md$/i,
  /\.sql$/i,
  /(^|[\\/])\.DS_Store$/,
];

// node_modules holds the development packages too. The AWS SDK is provided
// by the Lambda runtime, so shipping a copy only makes the upload bigger.
const SKIP_IN_NODE_MODULES = [/^\.bin$/, /^@aws-sdk$/, /^aws-sdk$/, /^\.package-lock\.json$/];

function excluded(relativePath) {
  return NEVER.some((pattern) => pattern.test(relativePath));
}

function walk(dir, base, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(base, full).split(path.sep).join('/');
    if (excluded(relative)) continue;
    if (entry.isDirectory()) walk(full, base, files);
    else if (entry.isFile()) files.push({ full, relative });
  }
  return files;
}

function collect() {
  const files = [];

  for (const name of INCLUDE_FILES) {
    const full = path.join(ROOT, name);
    if (fs.existsSync(full)) files.push({ full, relative: name });
  }

  for (const name of INCLUDE_DIRS) {
    const full = path.join(ROOT, name);
    if (fs.existsSync(full)) walk(full, ROOT, files);
  }

  const modules = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(modules)) {
    console.error('node_modules is missing. Run: npm install --omit=dev');
    process.exit(1);
  }
  for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
    if (SKIP_IN_NODE_MODULES.some((pattern) => pattern.test(entry.name))) continue;
    const full = path.join(modules, entry.name);
    if (entry.isDirectory()) walk(full, ROOT, files);
  }

  return files;
}

// --- the zip format ---------------------------------------------------------
// A zip is a list of [local header + compressed bytes], then a central
// directory describing them, then a short end record. Everything is
// little-endian. Deflate is the standard method (8); zlib does the
// compressing.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function build(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.relative, 'utf8');
    const contents = fs.readFileSync(file.full);
    const compressed = zlib.deflateRawSync(contents, { level: 9 });
    const crc = crc32(contents);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (1 Jan 1996; a fixed date keeps
    local.writeUInt32LE(crc, 14); //  the zip identical between builds)
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(contents.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(0, 38); // external attributes
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuffer, end]);
}

// --- run --------------------------------------------------------------------

const files = collect();

const leaked = files.filter((file) => /\.env/i.test(file.relative));
if (leaked.length > 0) {
  // Belt and braces: the filters above already stop this, but a zip that
  // ships a secret is not something to find out about later.
  console.error('Refusing to build: these look like secret files:', leaked.map((f) => f.relative));
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, build(files));

const sizeMb = (fs.statSync(OUT_FILE).size / (1024 * 1024)).toFixed(2);
console.log(`Wrote ${OUT_FILE}`);
console.log(`${files.length} files, ${sizeMb} MB`);
console.log('Upload it with: aws lambda update-function-code --function-name route-stop-api \\');
console.log('  --zip-file fileb://dist/route-stop-api.zip');
