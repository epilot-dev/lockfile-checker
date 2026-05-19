# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@epilot/lockfile-checker` — a CLI that fails if any package version in (or newly added to) a lockfile is younger than a configurable threshold on the npm registry. See `README.md` for end-user documentation.

Two modes:
- **Diff mode** (`--base <ref>`) — gate the new packages on a branch. Used in CI.
- **Scan mode** (no `--base`) — audit every package in the lockfile. Used for onboarding and scheduled re-scans.

## Toolchain

- **Node**: ≥ 20 required (uses built-in `fetch` and `node:util.parseArgs`). Repo pins Node 24 in `.nvmrc`.
- **Package manager**: pnpm 11.1.2, declared via `devEngines.packageManager`. Use `pnpm install` directly — Corepack auto-fetches.
- **Module system**: `"type": "module"` in the project. **The published bin (`dist/index.cjs`) is CJS** — `snyk-nodejs-lockfile-parser` uses `__dirname` and dynamic `require()` internally, which breaks ESM bundling. Source stays ESM (`src/*.ts`); only the bundled artifact is CJS.

## Commands

```sh
pnpm install            # also approves the esbuild build (pnpm-workspace.yaml)
pnpm typecheck          # tsc --noEmit
pnpm test               # vitest run (80 tests, no network)
pnpm test:coverage      # vitest run --coverage (gated at lines ≥ 90, branches ≥ 80)
pnpm build              # node scripts/build.mjs → dist/index.cjs
```

Run a single test file: `pnpm test test/extract.test.ts` (or `node_modules/.bin/vitest run test/extract.test.ts`).

The `pnpm-workspace.yaml` only exists to allow esbuild's postinstall script. Don't be misled — this is **not** a workspace repo.

## Architecture

Pure layers stitched together by `src/index.ts`'s `main(deps)` — everything except `bin.ts` is side-effect-free and dependency-injected:

| Module | Responsibility |
| --- | --- |
| `config.ts` | Parse argv + env into a typed `Config`. CLI > env > default precedence. Returns a discriminated union (`config` / `help` / `version` / `error`). |
| `filters.ts` | Apply allow-lists and version-shape rule (`/^\d+\.\d+\.\d+/`) before any network call. Deduplicates the package list. |
| `extract.ts` | Read lockfiles via `snyk-nodejs-lockfile-parser` (one of `parsePnpmProject` / `parseNpmLockV2Project` / `parseYarnLockV1Project` / `parseYarnLockV2Project`). Normalises pnpm peer-disambig suffixes (`foo@1.0.0(bar@2.0.0)` → `foo@1.0.0`). Computes `headSet \ baseSet` (diff) or `headSet` (scan). |
| `registry.ts` | Bounded-concurrency worker pool over a `fetch` shape. Returns `ok` or `warning` per package; only throws on 5xx/network errors when `failOnError`. |
| `report.ts` | Pure render of the final stdout/stderr lines. Owns the `ProgressWriter` (TTY-aware, throttled to 2s, suppressed by `--quiet`). |
| `index.ts` | Wires the layers in `main(deps)`. Pure: no `process.exit`, no real `fetch`, no real `git`. |
| `bin.ts` | Production wiring — real `fs`, `child_process.spawn` for `git show <ref>:<path>`, real `fetch`. Calls `process.exit(code)`. The build entry. |

The split between `index.ts` and `bin.ts` is load-bearing: tests can drive `main()` with full fakes (see `test/util/reader.ts` and the synthetic registries in `test/integration.test.ts`), while `bin.ts` exists only to bridge `main()` to the OS.

### Version is baked at build time

`bin.ts` declares `__LQ_VERSION__`; `scripts/build.mjs` substitutes it with the `package.json` `version` via esbuild's `define`. Don't try to `readFile(package.json)` at runtime in the bundle — the bundle is single-file and the package.json's location is not stable post-publish.

## Test fixtures

Live under `test/fixtures/{pnpm,npm,yarn-v1,yarn-berry}/<variant>/`. The tree was produced by **real** `pnpm install` / `npm install` / `yarn install` runs (see `test/fixtures/...` shape). The exact commands are in `test/util/reader.ts`'s git history if regeneration is needed. If you regenerate, keep the variants stable: `base`, `head-add`, `head-bump`, `head-remove` are referenced by name from the test suites.

Special pnpm fixtures cover edges:
- `peer-disambig/` — react + react-dom + react-redux, to exercise pnpm's `(peer@version)` suffix.
- `aliased/` — `my-lodash: npm:lodash.kebabcase@4.1.1`, to check `honorAliases`.
- `workspace/` — root + `apps/a` + `apps/b`, to check workspace members are excluded.

Tests never hit the real registry. The integration suite injects a `fetch` fake (see `registryFor()` in `test/integration.test.ts`) and pins time via `now: () => NOW`.
