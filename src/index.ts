import { parseConfig } from './config.js';
import { applyFilters } from './filters.js';
import { extractPackagesUnderReview, type FileReader } from './extract.js';
import { lookupPackages, type FetchFn } from './registry.js';
import { ProgressWriter, renderReport } from './report.js';

/**
 * Dependencies the CLI's `main` accepts so tests can replace them. The
 * production wiring lives in `bin.ts`; `main` itself is pure-ish.
 */
export interface Deps {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  reader: FileReader;
  fetch: FetchFn;
  now: () => Date;
  stdout: { write(s: string): void; isTTY?: boolean };
  stderr: { write(s: string): void; isTTY?: boolean };
  version: string;
}

/**
 * Run the CLI end-to-end. Returns the process exit code. Never throws for
 * user-visible errors — all failure paths produce a code (1 or 2) and have
 * already been written to stderr.
 *
 * Exit codes:
 *   0 — no offenders
 *   1 — offenders, or registry error with --fail-on-registry-error
 *   2 — invalid configuration / git failure in diff mode
 */
export async function main(deps: Deps): Promise<number> {
  const parsed = parseConfig(deps.argv, deps.env, deps.version);
  if (parsed.kind === 'help') {
    deps.stdout.write(`${parsed.message}\n`);
    return 0;
  }
  if (parsed.kind === 'version') {
    deps.stdout.write(`${parsed.message}\n`);
    return 0;
  }
  if (parsed.kind === 'error') {
    deps.stderr.write(`${parsed.message}\n`);
    return 2;
  }
  const config = parsed.config;

  let extracted;
  try {
    extracted = await extractPackagesUnderReview({
      mode: config.mode,
      baseRef: config.baseRef,
      reader: deps.reader,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.stderr.write(`${msg}\n`);
    if (config.mode === 'diff') {
      deps.stderr.write(
        `Diff mode requires a resolvable base ref. Try a deeper fetch (e.g. \`git fetch --deepen=50\`) or correct the ref.\n`,
      );
    }
    return 2;
  }

  if (extracted.discoveredCount === 0) {
    deps.stderr.write(
      `No lockfile found at ${deps.cwd}. ` +
        `Expected one of: pnpm-lock.yaml, package-lock.json, yarn.lock ` +
        `(or a pnpm-workspace.yaml with member pnpm-lock.yaml files for shared-workspace-lockfile=false).\n` +
        `Run lockfile-checker from the directory that contains your lockfile.\n`,
    );
    return 2;
  }

  const { checked } = applyFilters(
    extracted.setUnderReview,
    config.allowedPackages,
    config.allowedScopes,
  );

  const progress = new ProgressWriter({
    stream: deps.stderr,
    now: () => deps.now().getTime(),
    disabled: config.quiet,
  });

  let lookups;
  try {
    lookups = await lookupPackages(checked, {
      registry: config.registry,
      concurrency: config.concurrency,
      failOnError: config.failOnRegistryError,
      fetch: deps.fetch,
      onProgress: (done, total) => progress.tick(done, total),
    });
  } catch (err) {
    progress.finalise();
    const msg = err instanceof Error ? err.message : String(err);
    deps.stderr.write(`${msg}\n`);
    return 1;
  }
  progress.finalise();

  const rendered = renderReport({
    mode: config.mode,
    minAgeHours: config.minAgeHours,
    totalUnderReview: checked.length,
    lockfileKinds: extracted.lockfileKindsSeen,
    extractWarnings: extracted.warnings,
    lookups,
    now: deps.now(),
  });

  if (rendered.stdoutLines.length > 0) {
    deps.stdout.write(`${rendered.stdoutLines[0]}\n`);
  }
  for (const line of rendered.stderrLines) {
    deps.stderr.write(`${line}\n`);
  }
  if (rendered.stdoutLines.length > 1) {
    for (let i = 1; i < rendered.stdoutLines.length; i++) {
      deps.stdout.write(`${rendered.stdoutLines[i]}\n`);
    }
  }

  return rendered.offenders.length > 0 ? 1 : 0;
}
