import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { delimiter, join, resolve, sep } from 'node:path';
import {
  formatVersionReport,
  formatUpgradeReport,
  resolvePackageJsonPath,
  readCurrentVersion,
  isRunningViaNpx,
  getNpmViewVersion,
  runUpgrade,
} from '../src/cli-meta.js';

// --- formatVersionReport: pure formatting, injected npm-view results (no network) ---

test('formatVersionReport: up to date', () => {
  const out = formatVersionReport('0.4.4', { ok: true, version: '0.4.4' });
  assert.equal(out, 'graft 0.4.4\nlatest on npm: 0.4.4 ✓ up to date');
});

test('formatVersionReport: newer version available', () => {
  const out = formatVersionReport('0.4.4', { ok: true, version: '0.4.5' });
  assert.equal(out, 'graft 0.4.4\nlatest on npm: 0.4.5 — run graft upgrade');
});

test('formatVersionReport: offline / unreachable', () => {
  const out = formatVersionReport('0.4.4', { ok: false });
  assert.equal(out, 'graft 0.4.4\nlatest: unreachable (offline?)');
});

// --- formatUpgradeReport: pure formatting, injected upgrade results (no network, no spawn) ---

test('formatUpgradeReport: npx no-op suggests a permanent install', () => {
  const out = formatUpgradeReport({ ran: false, ok: true, oldVersion: '0.4.4' });
  assert.match(out, /npx/);
  assert.match(out, /npm install -g @nanonets\/graft/);
});

test('formatUpgradeReport: successful upgrade shows old -> new', () => {
  const out = formatUpgradeReport({ ran: true, ok: true, oldVersion: '0.4.4', newVersion: '0.4.5' });
  assert.equal(out, 'graft 0.4.4 → 0.4.5');
});

test('formatUpgradeReport: failed install surfaces the error', () => {
  const out = formatUpgradeReport({ ran: true, ok: false, oldVersion: '0.4.4', errorMessage: 'ENOENT' });
  assert.match(out, /failed/);
  assert.match(out, /ENOENT/);
});

// --- resolvePackageJsonPath / readCurrentVersion: real filesystem, no network ---

test('resolvePackageJsonPath finds package.json one level above a dist/cli.js-shaped module path', () => {
  const fakeDistCli = pathToFileURL(resolve(process.cwd(), 'dist/cli.js')).href;
  const found = resolvePackageJsonPath(fakeDistCli);
  assert.equal(found, resolve(process.cwd(), 'package.json'));
});

test('resolvePackageJsonPath finds package.json one level above a src/cli.ts-shaped module path', () => {
  const fakeSrcCli = pathToFileURL(resolve(process.cwd(), 'src/cli.ts')).href;
  const found = resolvePackageJsonPath(fakeSrcCli);
  assert.equal(found, resolve(process.cwd(), 'package.json'));
});

test('readCurrentVersion reads the real package.json version', () => {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
  const v = readCurrentVersion(pathToFileURL(resolve(process.cwd(), 'src/cli.ts')).href);
  assert.equal(v, pkg.version);
});

// --- isRunningViaNpx: pure path heuristic ---
//
// Built with `join` rather than a `/`-separated literal so the path carries the
// platform separator: `fileURLToPath` hands back `…\_npx\…` on Windows, where the
// original `includes("/_npx/")` was always false and `graft upgrade` would have run
// `npm install -g` on top of an npx invocation. On posix this is the identity case.

test('isRunningViaNpx detects an npx cache path', () => {
  const npxPath = pathToFileURL(
    join(sep, 'Users', 'x', '.npm', '_npx', 'abc123', 'node_modules', '@nanonets', 'graft', 'dist', 'cli.js'),
  ).href;
  assert.equal(isRunningViaNpx(npxPath), true);
});

test('isRunningViaNpx is false for a regular global install', () => {
  const globalPath = pathToFileURL(
    join(sep, 'usr', 'local', 'lib', 'node_modules', '@nanonets', 'graft', 'dist', 'cli.js'),
  ).href;
  assert.equal(isRunningViaNpx(globalPath), false);
});

// --- npm launch: a fake npm first on PATH stands in for the real one ---
//
// On Windows `npm` is the `npm.cmd` shim, which spawnSync cannot start without a
// shell: `graft version` said "unreachable" on every run, the update check stored
// nothing and `graft upgrade` never ran. Ported from ansidium/trail-code-se7en
// (4fa301e664a8, MIT).

function withFakeNpm(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'graft-fake-npm-'));
  const globalRoot = join(dir, 'global');
  mkdirSync(join(globalRoot, '@nanonets', 'graft'), { recursive: true });
  writeFileSync(join(globalRoot, '@nanonets', 'graft', 'package.json'), '{"version":"9.9.9"}');
  const script = [
    'const args = process.argv.slice(2);',
    `require('fs').appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, args.join(' ') + '\\n');`,
    "if (args[0] === 'view') console.log('9.9.9');",
    `if (args[0] === 'root') console.log(${JSON.stringify(globalRoot)});`,
  ];
  writeFileSync(join(dir, 'fake-npm.cjs'), script.join('\n'));
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'npm.cmd'), `@"${process.execPath}" "%~dp0fake-npm.cjs" %*\r\n`);
  } else {
    writeFileSync(join(dir, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-npm.cjs" "$@"\n`);
    chmodSync(join(dir, 'npm'), 0o755);
  }
  const path = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${path}`;
  try {
    fn(dir);
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('getNpmViewVersion reads the latest version from npm on PATH', () => {
  withFakeNpm(() => {
    assert.deepEqual(getNpmViewVersion('@nanonets/graft', 30_000), { ok: true, version: '9.9.9' });
  });
});

test('runUpgrade runs npm install -g and reports the installed version', () => {
  withFakeNpm((dir) => {
    const result = runUpgrade(pathToFileURL(resolve('src', 'cli.ts')).href);
    assert.equal(result.ok, true, result.errorMessage);
    assert.equal(result.newVersion, '9.9.9');
    assert.match(readFileSync(join(dir, 'calls.log'), 'utf8'), /^install -g @nanonets\/graft@latest$/m);
  });
});
