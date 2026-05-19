import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { extractPackagesUnderReview } from '../src/extract.js';
import { FIXTURES_ROOT, fixtureReader } from './util/reader.js';

const ROOT = join(FIXTURES_ROOT, 'pnpm', 'unshared-workspace');

function fmtKey(p: { name: string; version: string }): string {
  return `${p.name}@${p.version}`;
}

describe('extract — pnpm shared-workspace-lockfile=false', () => {
  it('scan: discovers per-member pnpm-lock.yaml files via pnpm-workspace.yaml fallback', async () => {
    // The near-empty root pnpm-lock.yaml that pnpm produces in this mode
    // contains no deps; without member-lockfile discovery we'd silently scan
    // zero packages. The expected union here proves both members were read.
    const r = await extractPackagesUnderReview({
      mode: 'scan',
      baseRef: null,
      reader: fixtureReader({ headDir: join(ROOT, 'base') }),
    });
    expect(r.setUnderReview.map(fmtKey).sort()).toEqual([
      'is-number@6.0.0',
      'lodash.kebabcase@4.1.1',
    ]);
    expect(r.discoveredCount).toBe(3); // root + apps/a + apps/b
    expect(r.warnings).toEqual([]);
  });

  it('diff: a dep added inside one member is detected', async () => {
    const r = await extractPackagesUnderReview({
      mode: 'diff',
      baseRef: 'base-ref',
      reader: fixtureReader({
        headDir: join(ROOT, 'head-add-via-member'),
        baseDir: join(ROOT, 'base'),
      }),
    });
    expect(r.setUnderReview.map(fmtKey)).toEqual(['lodash.snakecase@4.1.1']);
    expect(r.warnings).toEqual([]);
  });
});
