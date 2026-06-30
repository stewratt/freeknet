// Auto-load a local .env into process.env at startup. Imported FIRST in
// server.ts (before any module that reads process.env at import time) so the
// values are in place before crypto.ts, api.ts, handshake.ts, etc. evaluate.
//
// Zero dependencies. Synchronous on purpose — ESM evaluates this side-effect
// import to completion before the next import statement runs.
//
// Precedence: real process.env (anything you pass on the command line) ALWAYS
// wins over the file, so `FREEKNET_LLM_MOCK=1 npm start` still overrides it.
// Files are tried in order; the first one that exists is used:
//   freeknet.env  →  .env

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CANDIDATES = ['freeknet.env', '.env'];

function parse(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (let raw of src.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // tolerate a leading `export ` so a file can double as a `source`-able shell script
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq === -1) continue;
    const key = body.slice(0, eq).trim();
    if (!key) continue;
    let val = body.slice(eq + 1).trim();
    // strip matching surrounding quotes; keep inner content verbatim
    const quoted =
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"));
    if (quoted && val.length >= 2) {
      val = val.slice(1, -1);
    } else {
      // for unquoted values, drop a trailing ` # inline comment`
      const hash = val.indexOf(' #');
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    out[key] = val;
  }
  return out;
}

function load(): void {
  for (const name of CANDIDATES) {
    let src: string;
    try {
      src = readFileSync(join(ROOT, name), 'utf8');
    } catch {
      continue; // not found — try the next candidate
    }
    const vars = parse(src);
    let applied = 0;
    for (const [key, val] of Object.entries(vars)) {
      if (process.env[key] === undefined) {
        process.env[key] = val;
        applied++;
      }
    }
    if (applied > 0 || Object.keys(vars).length > 0) {
      console.log(`[env] loaded ${applied} var(s) from ${name}`);
    }
    return; // first file that exists wins
  }
}

load();
