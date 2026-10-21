/**
 * Package entry points: `main`/`exports` (lib) must be importable without side
 * effects (no session, no transport), while the `bin` keeps its shebang.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const distLib = fileURLToPath(new URL('../dist/lib.js', import.meta.url));
const distBin = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const noDist = existsSync(distLib) ? false : 'dist/ not built (run npm run build)';

/** Runs a node script with stdin left open: a started server would never exit. */
function runNode(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        // Would be enough for index.ts to start a server.
        GLPI_URL: 'http://127.0.0.1:9',
        GLPI_USER_TOKEN: 'test',
        GLPI_MAX_RETRIES: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`process did not exit (server started?): ${stderr}`));
    }, 10_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const PROBE = `
  const lib = require(process.argv[1]);
  const names = ['GlpiClient', 'GlpiHttp', 'GlpiError', 'GlpiSearch', 'SearchOptionsCache', 'createMcpServer',
    'TICKET_STATUS', 'STATUS_BY_ITEMTYPE', 'text', 'htmlToText', 'compactItem'];
  const missing = names.filter((n) => lib[n] === undefined);
  if (missing.length) { console.error('missing exports: ' + missing.join(', ')); process.exit(1); }
  console.log('ok');
`;

test('package.json main/types/exports point to the side-effect-free lib, bin to the CLI', () => {
  assert.equal(pkg.main, 'dist/lib.js');
  assert.equal(pkg.types, 'dist/lib.d.ts');
  assert.equal(pkg.exports['.'].default, './dist/lib.js');
  assert.equal(pkg.bin['mcp-glpi'], 'dist/index.js');
});

test('src/lib.ts imports without starting a server', { timeout: 20_000 }, async () => {
  const lib = fileURLToPath(new URL('../src/lib.ts', import.meta.url));
  const res = await runNode(['--import', 'tsx', '-e', `import(${JSON.stringify(lib)}).then(() => console.log('ok'))`]);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'ok');
  assert.equal(res.stderr, '');
});

test('dist/lib.js requires without side effects and exposes the API', { timeout: 20_000, skip: noDist }, async () => {
  const res = await runNode(['-e', PROBE, distLib]);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'ok');
  assert.equal(res.stderr, '');
});

test('dist/index.js keeps its shebang', { skip: noDist }, () => {
  assert.ok(readFileSync(distBin, 'utf8').startsWith('#!/usr/bin/env node\n'));
});
