import { parseArgs } from 'node:util';

/**
 * Mode in which the tool operates.
 *
 * - `diff`: only packages newly introduced relative to a base ref are checked.
 * - `scan`: every package in the current lockfile(s) is checked.
 */
export type Mode = 'diff' | 'scan';

/**
 * Fully resolved configuration. Built from CLI args, environment variables, and
 * defaults — in that precedence order (CLI > env > default).
 */
export interface Config {
  mode: Mode;
  baseRef: string | null;
  minAgeHours: number;
  allowedPackages: ReadonlySet<string>;
  allowedScopes: ReadonlySet<string>;
  registry: string;
  concurrency: number;
  failOnRegistryError: boolean;
  quiet: boolean;
}

/**
 * Outcome of parsing argv + env into a configuration.
 *
 * - `kind: 'config'`: parsed successfully; the caller proceeds with `config`.
 * - `kind: 'help'`: the user asked for `--help`; `message` is the usage text.
 * - `kind: 'version'`: the user asked for `--version`; `message` is the package version.
 * - `kind: 'error'`: parsing failed; `message` is the error text. Caller should exit with code 2.
 */
export type ConfigResult =
  | { kind: 'config'; config: Config }
  | { kind: 'help'; message: string }
  | { kind: 'version'; message: string }
  | { kind: 'error'; message: string };

const DEFAULT_MIN_AGE_HOURS = 168;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_ALLOWED_SCOPES: readonly string[] = [];

const USAGE = `Usage: lockfile-checker [options]

Diff mode (gate a change): supply --base <ref> to check only newly added packages.
Scan mode (audit current tree): omit --base to check every package in the lockfile(s).

Options:
  --base <ref>                  Git ref to diff against. Enables diff mode. (env: BASE_REF)
  --min-age <hours>             Minimum age in hours, default 168. (env: MIN_PACKAGE_AGE_HOURS)
  --allow <list>                Comma-separated package names to skip. (env: ALLOWED_PACKAGES)
  --allow-scope <list>          Comma-separated scopes to skip (incl. @). (env: ALLOWED_SCOPES)
  --registry <url>              Registry URL, default https://registry.npmjs.org. (env: NPM_REGISTRY)
  --concurrency <n>             Max in-flight registry requests, default 8. (env: REGISTRY_CONCURRENCY)
  --fail-on-registry-error      Treat registry/network errors as failures. (env: FAIL_ON_REGISTRY_ERROR)
  --quiet                       Suppress progress output (warnings/offenders still print). (env: QUIET)
  --help                        Show this help and exit 0.
  --version                     Print version and exit 0.

Exit codes:
  0  no offenders
  1  at least one offender (or registry error with --fail-on-registry-error)
  2  invalid configuration
`;

/**
 * Parse argv (the array passed to `process.argv.slice(2)`) and the environment
 * into a typed {@link Config}.
 *
 * The function is pure: it does not read `process.argv` or `process.env`
 * directly, so tests can inject any values. It does not throw — all error
 * paths are returned as `{ kind: 'error' }`.
 *
 * @example
 * const result = parseConfig(['--base', 'origin/main'], process.env, '1.0.0');
 * if (result.kind === 'config') runWith(result.config);
 */
export function parseConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  version: string,
): ConfigResult {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv as string[],
      options: {
        base: { type: 'string' },
        'min-age': { type: 'string' },
        allow: { type: 'string' },
        'allow-scope': { type: 'string' },
        registry: { type: 'string' },
        concurrency: { type: 'string' },
        'fail-on-registry-error': { type: 'boolean' },
        quiet: { type: 'boolean' },
        help: { type: 'boolean' },
        version: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'error', message: `${msg}\n\n${USAGE}` };
  }

  const flags = parsed.values;

  if (flags.help) return { kind: 'help', message: USAGE };
  if (flags.version) return { kind: 'version', message: version };

  const baseFlag = typeof flags.base === 'string' ? flags.base : undefined;
  const baseEnv = env.BASE_REF;
  const baseRefRaw = baseFlag ?? baseEnv ?? '';
  const baseRef = baseRefRaw.trim() === '' ? null : baseRefRaw.trim();

  const minAgeRaw =
    (typeof flags['min-age'] === 'string' ? flags['min-age'] : undefined) ??
    env.MIN_PACKAGE_AGE_HOURS;
  const minAgeHours =
    minAgeRaw === undefined || minAgeRaw === '' ? DEFAULT_MIN_AGE_HOURS : Number(minAgeRaw);
  if (!Number.isFinite(minAgeHours) || minAgeHours < 0) {
    return { kind: 'error', message: `Invalid --min-age value: ${minAgeRaw}` };
  }

  const concurrencyRaw =
    (typeof flags.concurrency === 'string' ? flags.concurrency : undefined) ??
    env.REGISTRY_CONCURRENCY;
  const concurrency =
    concurrencyRaw === undefined || concurrencyRaw === ''
      ? DEFAULT_CONCURRENCY
      : Number(concurrencyRaw);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    return { kind: 'error', message: `Invalid --concurrency value: ${concurrencyRaw}` };
  }

  const allowedPackages = splitList(
    (typeof flags.allow === 'string' ? flags.allow : undefined) ?? env.ALLOWED_PACKAGES ?? '',
  );

  const allowedScopesRaw =
    (typeof flags['allow-scope'] === 'string' ? flags['allow-scope'] : undefined) ??
    env.ALLOWED_SCOPES;
  const allowedScopes = splitList(
    allowedScopesRaw === undefined ? DEFAULT_ALLOWED_SCOPES.join(',') : allowedScopesRaw,
  );

  const registry =
    (typeof flags.registry === 'string' ? flags.registry : undefined) ??
    env.NPM_REGISTRY ??
    DEFAULT_REGISTRY;

  const failOnRegistryError =
    flags['fail-on-registry-error'] === true ||
    parseBoolEnv(env.FAIL_ON_REGISTRY_ERROR);

  const quiet = flags.quiet === true || parseBoolEnv(env.QUIET);

  return {
    kind: 'config',
    config: {
      mode: baseRef === null ? 'scan' : 'diff',
      baseRef,
      minAgeHours,
      allowedPackages,
      allowedScopes,
      registry: registry.replace(/\/$/, ''),
      concurrency,
      failOnRegistryError,
      quiet,
    },
  };
}

function splitList(raw: string): Set<string> {
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

function parseBoolEnv(v: string | undefined): boolean {
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t === '1' || t === 'true' || t === 'yes';
}
