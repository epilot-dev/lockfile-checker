import { describe, it, expect } from 'vitest';
import { buildPackageUrl, lookupPackages, type FetchFn } from '../src/registry.js';

function fakeFetch(routes: Record<string, { status: number; body?: unknown }>): FetchFn {
  return async (url: string) => {
    const route = routes[url];
    if (!route) throw new Error(`unexpected URL: ${url}`);
    return {
      status: route.status,
      async json() {
        if (route.body === undefined) throw new Error('no body');
        return route.body;
      },
    };
  };
}

const PKG_REACT = { name: 'react', version: '18.2.0' };
const PKG_LODASH = { name: 'lodash', version: '4.17.21' };
const PKG_SCOPED = { name: '@types/node', version: '22.0.0' };

describe('buildPackageUrl', () => {
  it('plain name', () => {
    expect(buildPackageUrl('https://registry.npmjs.org', 'react')).toBe(
      'https://registry.npmjs.org/react',
    );
  });
  it('scoped name encodes the slash', () => {
    expect(buildPackageUrl('https://registry.npmjs.org', '@types/node')).toBe(
      'https://registry.npmjs.org/@types%2Fnode',
    );
  });
  it('strips trailing slash from registry', () => {
    expect(buildPackageUrl('https://r.example/', 'foo')).toBe('https://r.example/foo');
  });
  it('respects custom registry URL', () => {
    expect(buildPackageUrl('https://my.r.example', 'foo')).toBe('https://my.r.example/foo');
  });
});

describe('lookupPackages', () => {
  it('parses publish date on 200', async () => {
    const fetch = fakeFetch({
      'https://r/react': {
        status: 200,
        body: { time: { '18.2.0': '2024-06-01T00:00:00.000Z' } },
      },
    });
    const [r] = await lookupPackages([PKG_REACT], {
      registry: 'https://r',
      concurrency: 1,
      failOnError: false,
      fetch,
    });
    expect(r!.kind).toBe('ok');
    if (r!.kind !== 'ok') throw new Error('unreachable');
    expect(r!.publishedAt.toISOString()).toBe('2024-06-01T00:00:00.000Z');
  });

  it('returns warning on 404, does not throw', async () => {
    const fetch = fakeFetch({ 'https://r/react': { status: 404 } });
    const [r] = await lookupPackages([PKG_REACT], {
      registry: 'https://r',
      concurrency: 1,
      failOnError: false,
      fetch,
    });
    expect(r!.kind).toBe('warning');
    if (r!.kind !== 'warning') throw new Error('unreachable');
    expect(r!.reason).toMatch(/not on this registry/i);
  });

  it('warns when registry omits the time entry for that version', async () => {
    const fetch = fakeFetch({
      'https://r/lodash': {
        status: 200,
        body: { time: { '4.17.20': '2020-01-01T00:00:00Z' } },
      },
    });
    const [r] = await lookupPackages([PKG_LODASH], {
      registry: 'https://r',
      concurrency: 1,
      failOnError: false,
      fetch,
    });
    expect(r!.kind).toBe('warning');
  });

  it('5xx → warning if !failOnError, throws if failOnError', async () => {
    const fetch = fakeFetch({ 'https://r/react': { status: 503 } });
    const [r] = await lookupPackages([PKG_REACT], {
      registry: 'https://r',
      concurrency: 1,
      failOnError: false,
      fetch,
    });
    expect(r!.kind).toBe('warning');

    await expect(
      lookupPackages([PKG_REACT], {
        registry: 'https://r',
        concurrency: 1,
        failOnError: true,
        fetch,
      }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('network error → warning unless failOnError', async () => {
    const fetch: FetchFn = async () => {
      throw new Error('ECONNREFUSED');
    };
    const [r] = await lookupPackages([PKG_REACT], {
      registry: 'https://r',
      concurrency: 1,
      failOnError: false,
      fetch,
    });
    expect(r!.kind).toBe('warning');
    if (r!.kind !== 'warning') throw new Error('unreachable');
    expect(r!.reason).toMatch(/ECONNREFUSED/);

    await expect(
      lookupPackages([PKG_REACT], {
        registry: 'https://r',
        concurrency: 1,
        failOnError: true,
        fetch,
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('encodes scoped package URLs', async () => {
    const seen: string[] = [];
    const fetch: FetchFn = async (url) => {
      seen.push(url);
      return {
        status: 200,
        async json() {
          return { time: { '22.0.0': '2024-01-01T00:00:00Z' } };
        },
      };
    };
    await lookupPackages([PKG_SCOPED], {
      registry: 'https://r',
      concurrency: 1,
      failOnError: false,
      fetch,
    });
    expect(seen).toEqual(['https://r/@types%2Fnode']);
  });

  it('respects the concurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetch: FetchFn = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return {
        status: 200,
        async json() {
          return { time: { '1.0.0': '2024-01-01T00:00:00Z' } };
        },
      };
    };
    const pkgs = Array.from({ length: 20 }, (_, i) => ({ name: `p${i}`, version: '1.0.0' }));
    await lookupPackages(pkgs, {
      registry: 'https://r',
      concurrency: 3,
      failOnError: false,
      fetch,
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(0);
  });

  it('invokes onProgress once per completion', async () => {
    const seen: Array<[number, number]> = [];
    const fetch: FetchFn = async () => ({
      status: 200,
      async json() {
        return { time: { '1.0.0': '2024-01-01T00:00:00Z' } };
      },
    });
    const pkgs = Array.from({ length: 5 }, (_, i) => ({ name: `p${i}`, version: '1.0.0' }));
    await lookupPackages(pkgs, {
      registry: 'https://r',
      concurrency: 2,
      failOnError: false,
      fetch,
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen.length).toBe(5);
    expect(seen.at(-1)).toEqual([5, 5]);
  });
});
