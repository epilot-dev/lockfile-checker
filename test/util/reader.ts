import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileReader } from '../../src/extract.js';

async function readMaybe(dir: string, path: string): Promise<string | null> {
  try {
    return await readFile(join(dir, path), 'utf8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

async function listMaybe(dir: string, path: string): Promise<string[] | null> {
  try {
    const target = path === '.' || path === '' ? dir : join(dir, path);
    const entries = await readdir(target, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/**
 * A FileReader that maps HEAD reads to one directory and ref reads to another.
 * Use a single dir for scan-mode tests; supply both for diff-mode tests.
 */
export function fixtureReader(opts: {
  headDir: string;
  baseDir?: string;
}): FileReader {
  return {
    async readHead(path) {
      return await readMaybe(opts.headDir, path);
    },
    async readAtRef(_ref, path) {
      if (!opts.baseDir) return null;
      return await readMaybe(opts.baseDir, path);
    },
    async listHeadDir(path) {
      return await listMaybe(opts.headDir, path);
    },
    async listAtRefDir(_ref, path) {
      if (!opts.baseDir) return null;
      return await listMaybe(opts.baseDir, path);
    },
  };
}

/**
 * Reader that always returns null for ref reads. Useful when a test wants to
 * assert "no base data" behaviour without supplying any directory.
 */
export const nullBaseReader = (headDir: string): FileReader => ({
  async readHead(path) {
    return await readMaybe(headDir, path);
  },
  async readAtRef() {
    return null;
  },
  async listHeadDir(path) {
    return await listMaybe(headDir, path);
  },
  async listAtRefDir() {
    return null;
  },
});

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}

export const FIXTURES_ROOT = new URL('../fixtures/', import.meta.url).pathname;
