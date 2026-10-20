import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CliError } from './errors.js';

export class Credentials {
  constructor(directory) { this.directory = directory; }

  async checkDirectory(create = false) {
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const info = await lstat(this.directory);
      if (!info.isDirectory() || (process.platform !== 'win32' &&
          ((info.mode & 0o077) || info.uid !== process.getuid()))) throw new Error('Unsafe directory');
    } catch (error) {
      if (error.code === 'ENOENT' && !create) return;
      throw new CliError('credentials_unsafe', 'Use an owned, non-symlink credentials directory with mode 0700.');
    }
  }

  async read(name, fallback = {}) {
    await this.checkDirectory();
    let file;
    try {
      const path = join(this.directory, name);
      const info = await lstat(path);
      if (!info.isFile()) throw new Error('Unsafe file');
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const actual = await file.stat();
      if (!actual.isFile() || (process.platform !== 'win32' &&
          ((actual.mode & 0o077) || actual.uid !== process.getuid()))) throw new Error('Unsafe file');
      const data = JSON.parse(await file.readFile('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid file');
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw new CliError('credentials_unreadable', 'Cannot safely read ' + name + '. It must be valid JSON in an owned regular file with mode 0600.');
    } finally { await file?.close(); }
  }

  // shortcut: one registration writer per directory; add locking when concurrent sign-ins are supported.
  async write(name, value) {
    await this.checkDirectory(true);
    await this.read(name);
    const temporary = join(this.directory, '.' + name + '-' + randomUUID());
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value) + '\n'); }
      finally { await file.close(); }
      await rename(temporary, join(this.directory, name));
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
}
