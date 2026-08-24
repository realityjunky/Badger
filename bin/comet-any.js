#!/usr/bin/env node

import { access } from 'node:fs/promises';

try {
  await access(new URL('../dist/src/cli.js', import.meta.url));
} catch {
  console.error('Standalone Comet-any is not built. Run `npm run build` first.');
  process.exit(1);
}

await import('../dist/src/cli.js');
