// Test the distributable, not a global link into the source checkout.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
assert(npmCli, 'Run npm run test:package.');
const temporary = mkdtempSync(join(tmpdir(), 'dtwb-package-'));
const npm = (args, cwd = root) => execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8' });
try {
  const [packed] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temporary]));
  const names = packed.files.map(file => file.path);
  assert(names.includes('bin/dtwb.js'));
  assert(names.includes('src/cli.js'));
  assert(names.includes('LICENSE'));
  assert(names.every(name => ['package.json', 'README.md', 'LICENSE'].includes(name) || name.startsWith('bin/') || name.startsWith('src/')));
  npm(['install', '--prefix', temporary, '--ignore-scripts', '--no-audit', '--no-fund', resolve(temporary, packed.filename)], temporary);
  const installed = join(temporary, 'node_modules/@datawebot/cli');
  assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).license, 'MIT');
  assert.equal(readFileSync(join(installed, 'LICENSE'), 'utf8'), readFileSync(join(root, 'LICENSE'), 'utf8'));
  const executable = join(temporary, 'node_modules/.bin', process.platform === 'win32' ? 'dtwb.cmd' : 'dtwb');
  // Windows .cmd launchers require cmd; the generated paths contain no user input.
  const launch = args => execFileSync(process.platform === 'win32' ? '"' + executable + '"' : executable, args,
    { encoding: 'utf8', shell: process.platform === 'win32', cwd: temporary });
  assert.match(launch(['--help']), /Usage: dtwb/);
  assert.equal(launch(['--version']).trim(), packed.version);
  console.log('PASS: tarball allowlist, isolated install, dtwb --help and --version');
} finally { rmSync(temporary, { recursive: true, force: true }); }
