import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Credentials } from '../src/credentials.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dtwb-private-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new Credentials(directory) };
}

test('private files are written atomically and preserved across reads/updates', async t => {
  const { directory, store } = await fixture(t);
  assert.deepEqual(await store.read('credentials'), {});
  await store.write('credentials', { version: 1, profiles: { one: { api_key: 'fixture' } } });
  assert.equal((await store.read('credentials')).profiles.one.api_key, 'fixture');
  await store.write('credentials', { version: 1, profiles: { two: { api_key: 'updated' } } });
  assert.equal((await store.read('credentials')).profiles.two.api_key, 'updated');
  if (process.platform !== 'win32') {
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(directory, 'credentials'))).mode & 0o777, 0o600);
  }
});

test('insecure credential files/directories are refused, not silently chmodded', { skip: process.platform === 'win32' }, async t => {
  const { directory, store } = await fixture(t);
  const path = join(directory, 'credentials');
  await writeFile(path, '{}', { mode: 0o644 });
  await assert.rejects(store.read('credentials'), /0600/);
  await assert.rejects(store.write('credentials', { changed: true }), /0600/);
  assert.equal(await readFile(path, 'utf8'), '{}');
  await chmod(path, 0o600);
  await chmod(directory, 0o755);
  await assert.rejects(store.read('credentials'), /0700/);
});

test('symlink credential file/directory is rejected without overwriting target', { skip: process.platform === 'win32' }, async t => {
  const { directory, store } = await fixture(t);
  const target = join(directory, 'target');
  await writeFile(target, '{}', { mode: 0o600 });
  await symlink(target, join(directory, 'credentials'));
  await assert.rejects(store.read('credentials'), /0600/);
  await assert.rejects(store.write('credentials', { changed: true }));
  assert.equal(await readFile(target, 'utf8'), '{}');
  const link = join(directory, 'link');
  await symlink(directory, link);
  await assert.rejects(new Credentials(link).read('credentials'), /0700/);
});

test('malformed credential JSON is not overwritten', async t => {
  const { directory, store } = await fixture(t);
  const path = join(directory, 'credentials');
  await writeFile(path, 'not json', { mode: 0o600 });
  await assert.rejects(store.read('credentials'), /valid JSON/);
  await assert.rejects(store.write('credentials', {}));
  assert.equal(await readFile(path, 'utf8'), 'not json');
});
