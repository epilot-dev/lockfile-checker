import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { extractPackagesUnderReview } from '../src/extract.js';
import { FIXTURES_ROOT, fixtureReader, nullBaseReader } from './util/reader.js';

const FORMATS = ['pnpm', 'npm', 'yarn-v1', 'yarn-berry'] as const;

type Format = (typeof FORMATS)[number];

function fmtKey(p: { name: string; version: string }): string {
  return `${p.name}@${p.version}`;
}

async function extract(opts: {
  mode: 'diff' | 'scan';
  baseRef: string | null;
  headDir: string;
  baseDir?: string;
}) {
  return extractPackagesUnderReview({
    mode: opts.mode,
    baseRef: opts.baseRef,
    reader: fixtureReader({ headDir: opts.headDir, ...(opts.baseDir ? { baseDir: opts.baseDir } : {}) }),
  });
}

describe.each(FORMATS)('extract — format %s', (fmt: Format) => {
  const dir = (variant: string) => join(FIXTURES_ROOT, fmt, variant);

  it('diff: head-add yields exactly the newly introduced package', async () => {
    const r = await extract({
      mode: 'diff',
      baseRef: 'base-ref',
      headDir: dir('head-add'),
      baseDir: dir('base'),
    });
    expect(r.setUnderReview.map(fmtKey)).toEqual(['lodash.snakecase@4.1.1']);
    expect(r.warnings).toEqual([]);
  });

  it('diff: head-bump yields the new version only', async () => {
    const r = await extract({
      mode: 'diff',
      baseRef: 'base-ref',
      headDir: dir('head-bump'),
      baseDir: dir('base'),
    });
    expect(r.setUnderReview.map(fmtKey)).toEqual(['is-number@7.0.0']);
  });

  it('diff: head-remove yields empty set', async () => {
    const r = await extract({
      mode: 'diff',
      baseRef: 'base-ref',
      headDir: dir('head-remove'),
      baseDir: dir('base'),
    });
    expect(r.setUnderReview).toEqual([]);
  });

  it('diff: lockfile new at HEAD warns and falls back to full HEAD set', async () => {
    const r = await extractPackagesUnderReview({
      mode: 'diff',
      baseRef: 'base-ref',
      reader: nullBaseReader(dir('base')),
    });
    expect(r.setUnderReview.map(fmtKey)).toEqual(['is-number@6.0.0', 'lodash.kebabcase@4.1.1']);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings[0]!.message).toMatch(/new at HEAD/);
  });

  it('scan: full HEAD set, no warnings', async () => {
    const r = await extract({
      mode: 'scan',
      baseRef: null,
      headDir: dir('base'),
    });
    expect(r.setUnderReview.map(fmtKey)).toEqual(['is-number@6.0.0', 'lodash.kebabcase@4.1.1']);
    expect(r.warnings).toEqual([]);
  });
});

describe('extract — special pnpm fixtures', () => {
  it('peer-disambiguated keys are normalised and de-duplicated', async () => {
    const r = await extract({
      mode: 'scan',
      baseRef: null,
      headDir: join(FIXTURES_ROOT, 'pnpm', 'peer-disambig'),
    });
    const keys = r.setUnderReview.map(fmtKey);
    const reactDom = keys.filter((k) => k.startsWith('react-dom@'));
    expect(reactDom).toEqual(['react-dom@18.2.0']);
    // None of the keys should still carry a peer suffix.
    expect(keys.every((k) => !k.includes('('))).toBe(true);
  });

  it('aliased packages resolve to the real name (pnpm)', async () => {
    const r = await extract({
      mode: 'scan',
      baseRef: null,
      headDir: join(FIXTURES_ROOT, 'pnpm', 'aliased'),
    });
    expect(r.setUnderReview.map(fmtKey)).toEqual(['lodash.kebabcase@4.1.1']);
  });

  it('aliased packages resolve to the real name (npm)', async () => {
    const r = await extract({
      mode: 'scan',
      baseRef: null,
      headDir: join(FIXTURES_ROOT, 'npm', 'aliased'),
    });
    expect(r.setUnderReview.map(fmtKey)).toEqual(['lodash.kebabcase@4.1.1']);
  });

});

describe.each(FORMATS)('extract — workspace format %s', (fmt: Format) => {
  const dir = (variant: string) => join(FIXTURES_ROOT, fmt, 'workspace', variant);

  it('scan: includes packages declared in workspace members and excludes the members themselves', async () => {
    const r = await extract({
      mode: 'scan',
      baseRef: null,
      headDir: dir('base'),
    });
    expect(r.setUnderReview.map(fmtKey)).toEqual([
      'is-number@6.0.0',
      'lodash.kebabcase@4.1.1',
      'lodash.snakecase@4.1.1',
    ]);
    const names = r.setUnderReview.map((p) => p.name);
    expect(names).not.toContain('@ws/a');
    expect(names).not.toContain('@ws/b');
    expect(r.warnings).toEqual([]);
  });

  it('diff: dep added inside a member is flagged', async () => {
    const r = await extract({
      mode: 'diff',
      baseRef: 'base-ref',
      headDir: dir('head-add-via-member'),
      baseDir: dir('base'),
    });
    expect(r.setUnderReview.map(fmtKey)).toEqual(['lodash.camelcase@4.3.0']);
    expect(r.warnings).toEqual([]);
  });

  it('diff: dep bumped inside a member is flagged at the new version only', async () => {
    const r = await extract({
      mode: 'diff',
      baseRef: 'base-ref',
      headDir: dir('head-bump-via-member'),
      baseDir: dir('base'),
    });
    expect(r.setUnderReview.map(fmtKey)).toEqual(['is-number@7.0.0']);
  });

  it('diff: dep removed inside a member yields an empty set', async () => {
    const r = await extract({
      mode: 'diff',
      baseRef: 'base-ref',
      headDir: dir('head-remove-via-member'),
      baseDir: dir('base'),
    });
    expect(r.setUnderReview).toEqual([]);
  });
});

describe('extract — cross-format', () => {
  it('same name@version present in two lockfile types appears once', async () => {
    // Compose a virtual repo with both pnpm-lock.yaml and package-lock.json
    // by reading from two source dirs. The reader must field both files from
    // the same "head" view, so we hand-build it.
    const { readFile } = await import('node:fs/promises');
    const reader = {
      async readHead(p: string): Promise<string | null> {
        const sources: Record<string, string> = {
          'pnpm-lock.yaml': join(FIXTURES_ROOT, 'pnpm', 'base', 'pnpm-lock.yaml'),
          'package-lock.json': join(FIXTURES_ROOT, 'npm', 'base', 'package-lock.json'),
          'package.json': join(FIXTURES_ROOT, 'pnpm', 'base', 'package.json'),
        };
        const src = sources[p];
        if (!src) return null;
        try {
          return await readFile(src, 'utf8');
        } catch {
          return null;
        }
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
    expect(r.setUnderReview.map(fmtKey)).toEqual(['is-number@6.0.0', 'lodash.kebabcase@4.1.1']);
    expect(r.lockfileKindsSeen).toEqual(['pnpm', 'npm']);
  });
});
