import { describe, it, expect } from 'vitest';
import { applyFilters, isExcluded } from '../src/filters.js';

const EMPTY = new Set<string>();

describe('isExcluded', () => {
  it('passes a normal semver package', () => {
    expect(isExcluded({ name: 'react', version: '18.2.0' }, EMPTY, EMPTY)).toBe(false);
    expect(isExcluded({ name: 'react', version: '18.2.0-beta.1' }, EMPTY, EMPTY)).toBe(false);
  });

  it('filters by exact package name', () => {
    expect(
      isExcluded({ name: 'react', version: '18.2.0' }, new Set(['react']), EMPTY),
    ).toBe(true);
    expect(
      isExcluded({ name: 'react-dom', version: '18.2.0' }, new Set(['react']), EMPTY),
    ).toBe(false);
  });

  it('filters scoped names by their scope', () => {
    expect(
      isExcluded(
        { name: '@epilot/foo', version: '1.0.0' },
        EMPTY,
        new Set(['@epilot']),
      ),
    ).toBe(true);
    expect(
      isExcluded(
        { name: '@other/foo', version: '1.0.0' },
        EMPTY,
        new Set(['@epilot']),
      ),
    ).toBe(false);
    expect(
      isExcluded(
        { name: 'foo', version: '1.0.0' },
        EMPTY,
        new Set(['@epilot']),
      ),
    ).toBe(false);
  });

  it('rejects non-semver versions', () => {
    for (const v of ['workspace:*', 'link:../x', 'file:./bar.tgz', 'git+https://x/y.git', 'npm:alias@1.0.0', '~1.2.3', '^1.2.3']) {
      expect(isExcluded({ name: 'foo', version: v }, EMPTY, EMPTY)).toBe(true);
    }
  });
});

describe('applyFilters', () => {
  it('partitions and deduplicates', () => {
    const pkgs = [
      { name: 'react', version: '18.2.0' },
      { name: 'react', version: '18.2.0' }, // duplicate
      { name: '@epilot/foo', version: '1.0.0' },
      { name: 'ws-thing', version: 'workspace:*' },
    ];
    const { checked, excluded } = applyFilters(pkgs, EMPTY, new Set(['@epilot']));
    expect(checked).toEqual([{ name: 'react', version: '18.2.0' }]);
    expect(excluded.map((p) => p.name).sort()).toEqual(['@epilot/foo', 'ws-thing']);
  });
});
