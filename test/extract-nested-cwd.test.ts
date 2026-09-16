import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileReader } from '../src/extract.js';
import { git, runGit } from './util/git.js';

/**
 * Regression: CI scans standalone sub-projects (e.g. `lambda/Handler`) with
 * `cwd` set to the sub-project, but `git show <ref>:<path>` is always
 * repository-relative. Without prefixing, `<ref>:package-lock.json` resolved
 * the *root* lockfile at the base ref, so every package in the sub-project
 * looked newly added and the age gate failed on packages that were already on
 * the default branch.
 *
 * Uses a real throw-away git repository with a root lockfile and a nested one.
 */
describe('createFileReader in a nested sub-project (real git)', () => {
  let repo: string;
  let nested: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'lq-git-'));
    nested = join(repo, 'lambda', 'Handler');
    await mkdir(join(nested, 'src'), { recursive: true });
    await mkdir(join(nested, 'tests'), { recursive: true });
    await mkdir(join(repo, 'docs'), { recursive: true });

    await writeFile(join(repo, 'package.json'), '{"name":"root"}\n');
    await writeFile(join(repo, 'package-lock.json'), '{"name":"root","lockfileVersion":3}\n');
    await writeFile(join(repo, 'docs', 'README.md'), 'docs\n');
    await writeFile(join(nested, 'package.json'), '{"name":"nested"}\n');
    await writeFile(join(nested, 'package-lock.json'), '{"name":"nested","lockfileVersion":3}\n');
    await writeFile(join(nested, 'src', 'index.js'), '');
    await writeFile(join(nested, 'tests', 'index.test.js'), '');

    await git(['init', '-q', '-b', 'main'], repo);
    await git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], repo);
    await git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'], repo);
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const makeReader = (cwd: string) =>
    createFileReader({
      cwd,
      fs: {
        readFile: (p, e) => readFile(p, e),
        readdir: (p, o) => readdir(p, o),
      },
      exec: runGit,
    });

  it('readAtRef resolves paths relative to cwd, not the repository root', async () => {
    const reader = makeReader(nested);
    const lock = await reader.readAtRef('HEAD', 'package-lock.json');
    expect(lock).toContain('"name":"nested"');
    expect(await reader.readAtRef('HEAD', 'package.json')).toContain('"name":"nested"');
    expect(await reader.readAtRef('HEAD', 'missing.json')).toBeNull();
  });

  it('readAtRef still works from the repository root', async () => {
    const reader = makeReader(repo);
    expect(await reader.readAtRef('HEAD', 'package-lock.json')).toContain('"name":"root"');
    expect(await reader.readAtRef('HEAD', 'lambda/Handler/package-lock.json')).toContain(
      '"name":"nested"',
    );
  });

  it('listAtRefDir lists the sub-project tree from within it', async () => {
    const reader = makeReader(nested);
    expect((await reader.listAtRefDir('HEAD', '.'))?.sort()).toEqual(['src', 'tests']);
    expect(await reader.listAtRefDir('HEAD', 'src')).toEqual([]);
    expect(await reader.listAtRefDir('HEAD', 'nope')).toBeNull();
  });

  it('listAtRefDir from the root sees root-level directories', async () => {
    const reader = makeReader(repo);
    expect((await reader.listAtRefDir('HEAD', '.'))?.sort()).toEqual(['docs', 'lambda']);
    expect(await reader.listAtRefDir('HEAD', 'lambda')).toEqual(['Handler']);
  });

  it('an unresolvable ref throws instead of reading as "absent"', async () => {
    const reader = makeReader(nested);
    await expect(reader.readAtRef('no-such-ref', 'package-lock.json')).rejects.toThrow(/git:/);
    await expect(reader.listAtRefDir('no-such-ref', '.')).rejects.toThrow(/git:/);
  });
});
