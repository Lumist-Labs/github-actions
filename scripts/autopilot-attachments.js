#!/usr/bin/env node
// Usage: node autopilot-attachments.js <issue-body.txt> <out-dir>; prints each saved path.

const fs = require('fs');
const path = require('path');

const [bodyPath, outDir] = process.argv.slice(2);
// Only Beacon's own signed attachment links, because the issue body is untrusted
// and an arbitrary URL from it would have the runner fetch whatever it names.
const LINK =
  /https:\/\/beacon-api\.lumistlabs\.ai\/api\/v1\/public\/attachments\/[0-9a-f-]{36}\?exp=\d+&sig=[0-9a-f]{64}/g;
const MAX_FILES = 6;
const MAX_BYTES = 5 * 1024 * 1024;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

async function main() {
  const body = fs.readFileSync(bodyPath, 'utf8');
  const links = [...new Set(body.match(LINK) || [])].slice(0, MAX_FILES);
  if (!links.length) return;
  fs.mkdirSync(outDir, { recursive: true });
  for (const [i, url] of links.entries()) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const type = (res.headers.get('content-type') || '').split(';')[0].trim();
      if (!res.ok || !EXT[type]) {
        console.error(`::warning::skipped attachment ${i + 1}: HTTP ${res.status} ${type || 'no type'}`);
        continue;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_BYTES) {
        console.error(`::warning::skipped attachment ${i + 1}: ${bytes.length} bytes is over the cap`);
        continue;
      }
      const file = path.join(outDir, `screenshot-${i + 1}.${EXT[type]}`);
      fs.writeFileSync(file, bytes);
      console.log(file);
    } catch (e) {
      console.error(`::warning::skipped attachment ${i + 1}: ${e.message}`);
    }
  }
}

main();
