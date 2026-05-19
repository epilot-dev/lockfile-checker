# @epilot/lockfile-checker

A CLI that fails if any package version in (or newly added to) a lockfile is younger than a configurable threshold on the npm registry. Defends against npm supply-chain attacks (Shai-Hulud-style malicious releases of legitimate packages) by enforcing a **quarantine window**.

Works with `pnpm-lock.yaml`, `package-lock.json`, and `yarn.lock` (both v1 and berry), in single-package and workspace repos. For pnpm workspaces with `shared-workspace-lockfile=false`, the tool also discovers per-member `pnpm-lock.yaml` files automatically.

## Install

Run on demand via `npx` (recommended — pins to a single version per invocation):

```bash
npx @epilot/lockfile-checker [options]
```

Or add as a dev dependency:

```bash
pnpm add -D @epilot/lockfile-checker
```

Requires **Node ≥ 20**.

## Two modes

### Diff mode — gate a change

Supply `--base <ref>` to check only the packages newly introduced relative to that ref. This is the natural fit for MR/PR gate pipelines.

```bash
# Fail if anything added on this branch was published less than a week ago.
npx @epilot/lockfile-checker --base origin/main
```

Requires the working directory to be inside a git repository and the base ref to be resolvable. If your CI does a shallow clone, deepen it first (`git fetch --deepen=50`) or fetch the base ref explicitly.

### Scan mode — audit the whole tree

Omit `--base` (or leave `BASE_REF` empty) to check every package in the lockfile(s). Use this for repo onboarding, one-off audits, and scheduled re-scans that catch packages compromised *after* they entered your tree.

```bash
npx @epilot/lockfile-checker
```

Scan mode does not require a git repository.

## Flags

Every flag has an environment-variable equivalent. Precedence: **CLI flag > env var > default**.

| Flag | Env var | Default | What it does |
| --- | --- | --- | --- |
| `--base <ref>` | `BASE_REF` | _(unset → scan mode)_ | Git ref to diff against. Presence selects diff mode. |
| `--min-age <hours>` | `MIN_PACKAGE_AGE_HOURS` | `168` | Minimum allowed age of any package version, in hours. |
| `--allow <list>` | `ALLOWED_PACKAGES` | _(empty)_ | Comma-separated package names to skip. |
| `--allow-scope <list>` | `ALLOWED_SCOPES` | _(empty)_ | Comma-separated scopes to skip (include the leading `@`). |
| `--registry <url>` | `NPM_REGISTRY` | `https://registry.npmjs.org` | Registry to query for publish times. Must return standard npm metadata. |
| `--concurrency <n>` | `REGISTRY_CONCURRENCY` | `8` | Max in-flight registry requests. |
| `--fail-on-registry-error` | `FAIL_ON_REGISTRY_ERROR=true` | `false` | Treat HTTP/network errors as failures instead of warnings. |
| `--quiet` | `QUIET=true` | `false` | Suppress the progress line. Warnings and offenders still print. |
| `--help` | — | — | Print usage and exit `0`. |
| `--version` | — | — | Print the package version and exit `0`. |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No offenders. |
| `1` | At least one offender. Or a registry error if `--fail-on-registry-error` is set. |
| `2` | Invalid configuration: unknown flag, diff mode in a non-git directory, unresolvable base ref, or no lockfile present at the working directory. |

Distinguishing `1` (legitimate "blocked" outcome) from `2` (misconfiguration) lets callers handle them differently — a typical CI gate fails the job on `1` and quarantines the runner / pings infra on `2`.

## Output

Standard format on a successful run:

```
Found 3 newly added package@version pair(s).
✅ All packages are at least 168h old.
```

On failure, offenders are printed on stderr, sorted ascending by age:

```
Found 4 newly added package@version pair(s).

❌ 1 package(s) younger than 168h:

   suspicious-pkg@2.0.1  —  0.3h old  (2026-05-18T23:42:11.000Z)

Allow via --allow <name>,<name> (or ALLOWED_PACKAGES=…), or wait until they age past 168h.
```

Warnings (e.g. a package not found on the configured registry, or a malformed lockfile) print on stderr above the offender list but do not fail the run by themselves.

## What is *not* covered

This tool checks publish-time only. It is one defensive layer; not a replacement for:

- **CVE scanning** (Snyk, Dependabot, `npm audit`) — known vulnerabilities, not novel attacks.
- **Lockfile integrity** (`lockfile-lint`) — that the `resolved`/`integrity` fields are honest.
- **Provenance / signature verification** (npm provenance, sigstore).

It also does not detect packages that were yanked, unpublished, or republished without a version bump.

## Limitations

- The tool always queries the **registry referenced by `--registry`** (default: the public npm registry) for every package not filtered by `--allow` or `--allow-scope`. Internal packages must be added to one of those lists.
- The working directory must contain a lockfile (or a `pnpm-workspace.yaml` whose members do). The tool does **not** recursively walk arbitrary nested directories looking for lockfiles — invoke it from the project root.

## License

MIT
