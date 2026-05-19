import type { Pkg } from './filters.js';

/**
 * Outcome of looking up a single `name@version` on the registry.
 *
 * - `ok`: the registry returned valid metadata; `publishedAt` is the publish
 *   timestamp parsed from `time[version]`.
 * - `warning`: the lookup could not produce a timestamp but is non-fatal —
 *   examples: 404 (package missing on this registry), missing `time[version]`
 *   field, optionally network/5xx errors when `failOnError` is false.
 *   `reason` is human-readable; the package is excluded from the offender check.
 */
export type LookupResult =
  | { kind: 'ok'; pkg: Pkg; publishedAt: Date }
  | { kind: 'warning'; pkg: Pkg; reason: string };

/**
 * Minimal `fetch` shape the registry client needs. Tests inject fakes; in
 * production this is `globalThis.fetch`.
 */
export type FetchFn = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Callback invoked once per lookup completion (success, warning, or thrown
 * fatal). Used by the reporter to drive its progress line. The reporter
 * decides when to render — it should treat this as a "tick" only.
 */
export type ProgressCallback = (done: number, total: number) => void;

export interface LookupOptions {
  registry: string;
  concurrency: number;
  /** If true, fatal HTTP / network errors throw; otherwise they become warnings. */
  failOnError: boolean;
  fetch: FetchFn;
  onProgress?: ProgressCallback;
}

/**
 * Build the registry URL for a package name. Scoped names url-encode the
 * `/`; the leading `@` is left literal because npm's registry accepts both
 * forms but encoded `%40@types%2Fnode` is uglier and the literal works.
 *
 * @example
 *   buildPackageUrl('https://registry.npmjs.org', '@types/node')
 *     // 'https://registry.npmjs.org/@types%2Fnode'
 *   buildPackageUrl('https://registry.npmjs.org', 'react')
 *     // 'https://registry.npmjs.org/react'
 */
export function buildPackageUrl(registry: string, name: string): string {
  const base = registry.replace(/\/$/, '');
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    if (slash > 0) {
      return `${base}/${name.slice(0, slash)}%2F${encodeURIComponent(name.slice(slash + 1))}`;
    }
  }
  return `${base}/${encodeURIComponent(name)}`;
}

interface NpmMetadata {
  time?: Record<string, string>;
}

function looksLikeNpmMetadata(v: unknown): v is NpmMetadata {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Look up the publish time of one `name@version` on the registry.
 *
 * Returns either an `ok` result, a `warning` (non-fatal), or throws if
 * `failOnError` is true and a hard error occurs. Soft cases:
 *
 *   - 404               → warning ("not on this registry")
 *   - missing time[v]   → warning ("registry returned no publish time")
 *   - 5xx / network     → throws iff `failOnError`; else warning
 */
async function lookupOne(
  pkg: Pkg,
  opts: Pick<LookupOptions, 'registry' | 'failOnError' | 'fetch'>,
): Promise<LookupResult> {
  const url = buildPackageUrl(opts.registry, pkg.name);

  let response;
  try {
    response = await opts.fetch(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.failOnError) throw new Error(`Registry fetch failed for ${pkg.name}: ${msg}`);
    return { kind: 'warning', pkg, reason: `network error: ${msg}` };
  }

  if (response.status === 404) {
    return { kind: 'warning', pkg, reason: 'not on this registry' };
  }
  if (response.status < 200 || response.status >= 300) {
    const msg = `registry returned HTTP ${response.status}`;
    if (opts.failOnError) throw new Error(`Registry error for ${pkg.name}: ${msg}`);
    return { kind: 'warning', pkg, reason: msg };
  }

  let body;
  try {
    body = await response.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.failOnError) throw new Error(`Registry JSON parse failed for ${pkg.name}: ${msg}`);
    return { kind: 'warning', pkg, reason: `invalid JSON from registry: ${msg}` };
  }

  if (!looksLikeNpmMetadata(body)) {
    return { kind: 'warning', pkg, reason: 'registry response is not npm metadata' };
  }
  const time = body.time?.[pkg.version];
  if (typeof time !== 'string') {
    return { kind: 'warning', pkg, reason: 'registry returned no publish time' };
  }

  const parsed = new Date(time);
  if (Number.isNaN(parsed.getTime())) {
    return { kind: 'warning', pkg, reason: `unparseable publish time: ${time}` };
  }
  return { kind: 'ok', pkg, publishedAt: parsed };
}

/**
 * Look up all packages in parallel, bounded to `opts.concurrency` in-flight
 * requests. Resolves once every package has either an `ok` or `warning`
 * result (or has caused a throw when `failOnError`).
 *
 * The function is deterministic in its output order: the returned array
 * preserves the input order, not the completion order.
 */
export async function lookupPackages(
  pkgs: readonly Pkg[],
  opts: LookupOptions,
): Promise<LookupResult[]> {
  const results: LookupResult[] = new Array(pkgs.length);
  let done = 0;
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= pkgs.length) return;
      const pkg = pkgs[i]!;
      const result = await lookupOne(pkg, opts);
      results[i] = result;
      done++;
      opts.onProgress?.(done, pkgs.length);
    }
  };

  const workerCount = Math.max(1, Math.min(opts.concurrency, pkgs.length));
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
