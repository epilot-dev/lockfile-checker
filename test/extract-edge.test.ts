import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPackagesUnderReview, createFileReader } from '../src/extract.js';
import type { FileReader } from '../src/extract.js';

describe('extract — warning paths', () => {
  it('warns when a lockfile is present but its package.json is missing at HEAD', async () => {
    const reader: FileReader = {
      async readHead(p) {
        if (p === 'pnpm-lock.yaml') return 'lockfileVersion: "9.0"\n';
        return null;
      },
      async readAtRef() {
        return null;
      },
      async listHeadDir() {
        return null;
      },
      async listAtRefDir() {
        return null;
      },
    };
    const r = await extractPackagesUnderReview({ mode: 'scan', baseRef: null, reader });
    expect(r.warnings.some((w) => /no package\.json at HEAD/i.test(w.message))).toBe(true);
    expect(r.setUnderReview).toEqual([]);
  });

  it('warns when HEAD lockfile content is malformed', async () => {
    const reader: FileReader = {
      async readHead(p) {
        if (p === 'pnpm-lock.yaml') return ':: not a valid yaml ::';
        if (p === 'package.json') return '{"name":"x","version":"1.0.0"}';
        return null;
      },
      async readAtRef() {
        return null;
      },
      async listHeadDir() {
        return null;
      },
      async listAtRefDir() {
        return null;
      },
    };
    const r = await extractPackagesUnderReview({ mode: 'scan', baseRef: null, reader });
    expect(r.warnings.some((w) => /Failed to parse .* at HEAD/.test(w.message))).toBe(true);
  });

  it('warns when base manifest is missing while base lockfile exists', async () => {
    const reader: FileReader = {
      async readHead(p) {
        if (p === 'pnpm-lock.yaml') return 'lockfileVersion: "9.0"\nimporters:\n  .: {}\npackages: {}\nsnapshots: {}\n';
        if (p === 'package.json') return '{"name":"x","version":"1.0.0"}';
        return null;
      },
      async readAtRef(_ref, p) {
        if (p === 'pnpm-lock.yaml')
          return 'lockfileVersion: "9.0"\nimporters:\n  .: {}\npackages: {}\nsnapshots: {}\n';
        return null;
      },
    };
    const r = await extractPackagesUnderReview({ mode: 'diff', baseRef: 'X', reader });
    expect(
      r.warnings.some((w) => /package\.json is not.*assuming base set is empty/.test(w.message)),
    ).toBe(true);
  });

  it('warns when base lockfile content is malformed', async () => {
    const reader: FileReader = {
      async readHead(p) {
        if (p === 'pnpm-lock.yaml') return 'lockfileVersion: "9.0"\nimporters:\n  .: {}\npackages: {}\nsnapshots: {}\n';
        if (p === 'package.json') return '{"name":"x","version":"1.0.0"}';
        return null;
      },
      async readAtRef(_ref, p) {
        if (p === 'pnpm-lock.yaml') return 'not a yaml :::';
        if (p === 'package.json') return '{"name":"x","version":"1.0.0"}';
        return null;
      },
    };
    const r = await extractPackagesUnderReview({ mode: 'diff', baseRef: 'X', reader });
    expect(
      r.warnings.some((w) => /Failed to parse .* at X.*assuming base set is empty/.test(w.message)),
    ).toBe(true);
  });
});

describe('createFileReader', () => {
  it('readHead returns content for an existing file and null for ENOENT', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lq-'));
    try {
      const fs = await import('node:fs/promises');
      await writeFile(join(dir, 'a.txt'), 'hello');
      const reader = createFileReader({
        cwd: dir,
        fs: {
          readFile: (p, e) => fs.readFile(p, e),
          readdir: (p, o) => fs.readdir(p, o),
        },
        exec: async () => ({ stdout: '', stderr: '', code: 0 }),
      });
      expect(await reader.readHead('a.txt')).toBe('hello');
      expect(await reader.readHead('missing.txt')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('readAtRef shells out and returns stdout on code 0', async () => {
    const reader = createFileReader({
      cwd: '/anywhere',
      fs: {
        readFile: async () => '',
        readdir: async () => [],
      },
      exec: async (cmd, args, cwd) => {
        expect(cmd).toBe('git');
        expect(args).toEqual(['show', 'origin/main:package.json']);
        expect(cwd).toBe('/anywhere');
        return { stdout: '{"name":"ok"}', stderr: '', code: 0 };
      },
    });
    expect(await reader.readAtRef('origin/main', 'package.json')).toBe('{"name":"ok"}');
  });

  it('readAtRef returns null for "missing path at ref" (non-zero, no ref error message)', async () => {
    const reader = createFileReader({
      cwd: '/anywhere',
      fs: {
        readFile: async () => '',
        readdir: async () => [],
      },
      exec: async () => ({
        stdout: '',
        stderr: "fatal: path 'foo' does not exist in 'origin/main'",
        code: 128,
      }),
    });
    expect(await reader.readAtRef('origin/main', 'foo')).toBeNull();
  });

  it('readAtRef throws when stderr indicates the ref itself is unresolvable', async () => {
    const reader = createFileReader({
      cwd: '/anywhere',
      fs: {
        readFile: async () => '',
        readdir: async () => [],
      },
      exec: async () => ({
        stdout: '',
        stderr: "fatal: bad revision 'no-such'",
        code: 128,
      }),
    });
    await expect(reader.readAtRef('no-such', 'foo')).rejects.toThrow(/bad revision/);
  });

  it('readHead surfaces non-ENOENT fs errors', async () => {
    const reader = createFileReader({
      cwd: '/x',
      fs: {
        readFile: async () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        },
        readdir: async () => [],
      },
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    });
    await expect(reader.readHead('a')).rejects.toThrow(/EACCES/);
  });
});
