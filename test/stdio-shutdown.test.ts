/**
 * stdio mode: when the client closes stdin the server shuts down (kills the
 * GLPI session, exit 0) instead of lingering as an orphan process.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));

test('stdio server exits 0 when stdin ends', { timeout: 20_000 }, async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    env: {
      PATH: process.env.PATH,
      // Unreachable GLPI: startup only logs a warning.
      GLPI_URL: 'http://127.0.0.1:9',
      GLPI_USER_TOKEN: 'test',
      GLPI_MAX_RETRIES: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));

  // Wait until the transport is up, then hang up.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${stderr}`)), 15_000);
    child.stderr.on('data', () => {
      if (stderr.includes('running on stdio')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  child.stdin.end();

  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  assert.equal(code, 0, stderr);
  assert.match(stderr, /Shutting down \((stdin|stdio)/);
});
