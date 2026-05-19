import {
  parseNpmLockV2Project,
  parsePnpmProject,
  parsePnpmWorkspaceProject,
  parseYarnLockV1Project,
  parseYarnLockV1WorkspaceProject,
  parseYarnLockV2Project,
  getPnpmLockfileVersion,
  getYarnLockfileVersion,
  NodeLockfileVersion,
} from 'snyk-nodejs-lockfile-parser';
import type { Pkg } from './filters.js';

/**
 * A lockfile shape we know how to parse. Determines which snyk parser we call
 * and which manifest path we look up.
 */
export type LockfileKind = 'pnpm' | 'npm' | 'yarn';

interface LockfileSpec {
  kind: LockfileKind;
  lockfilePath: string;
  manifestPath: string;
}

/**
 * The set of lockfiles this tool understands. Listed in the same order they
 * are probed: a repo mid-migration may have more than one (e.g. yarn → pnpm),
 * and we union their contents.
 */
export const KNOWN_LOCKFILES: readonly LockfileSpec[] = [
  { kind: 'pnpm', lockfilePath: 'pnpm-lock.yaml', manifestPath: 'package.json' },
  { kind: 'npm', lockfilePath: 'package-lock.json', manifestPath: 'package.json' },
  { kind: 'yarn', lockfilePath: 'yarn.lock', manifestPath: 'package.json' },
];

/**
 * Abstraction over reading file content. Tests inject fakes; production wires
 * the real filesystem and `git show` here.
 */
export interface FileReader {
  /** Read working-tree (HEAD) content. Returns null if the file does not exist. */
  readHead(path: string): Promise<string | null>;
  /**
   * Read content at a git ref. Returns null if the file does not exist at
   * that ref. Only called in diff mode. May throw if the ref cannot be
   * resolved at all — the caller treats that as a config error (exit 2).
   */
  readAtRef(ref: string, path: string): Promise<string | null>;
  /**
   * List subdirectory names of `path` at HEAD. Returns null if `path` does not
   * exist. Only used by yarn workspace glob expansion.
   */
  listHeadDir(path: string): Promise<string[] | null>;
  /**
   * List subdirectory names of `path` at the given git ref. Returns null if
   * `path` does not exist at that ref. Only used by yarn workspace glob
   * expansion in diff mode.
   */
  listAtRefDir(ref: string, path: string): Promise<string[] | null>;
}

/**
 * Warning emitted during extraction. Surfaced to the user via the reporter.
 */
export interface ExtractWarning {
  message: string;
}

/**
 * The output of {@link extractPackagesUnderReview}. The reporter and registry
 * client consume `setUnderReview`; warnings are surfaced verbatim.
 */
export interface ExtractResult {
  setUnderReview: Pkg[];
  lockfileKindsSeen: LockfileKind[];
  warnings: ExtractWarning[];
}

const SNYK_PARSE_OPTS_PNPM = {
  includeDevDeps: true,
  includeOptionalDeps: true,
  includePeerDeps: false,
  strictOutOfSync: false,
  pruneWithinTopLevelDeps: false,
  honorAliases: true,
} as const;

const SNYK_PARSE_OPTS_YARN_V1 = {
  includeDevDeps: true,
  includeOptionalDeps: true,
  includePeerDeps: false,
  strictOutOfSync: false,
  pruneLevel: 'none',
  honorAliases: true,
} as const;

const SNYK_PARSE_OPTS_YARN_V1_WORKSPACE = {
  includeDevDeps: true,
  includeOptionalDeps: true,
  includePeerDeps: false,
  strictOutOfSync: false,
  pruneCycles: false,
  honorAliases: true,
} as const;

const SNYK_PARSE_OPTS_YARN_V2 = {
  includeDevDeps: true,
  includeOptionalDeps: true,
  strictOutOfSync: false,
  pruneWithinTopLevelDeps: false,
  honorAliases: true,
} as const;

const SNYK_PARSE_OPTS_NPM = {
  includeDevDeps: true,
  includeOptionalDeps: true,
  includePeerDeps: false,
  strictOutOfSync: false,
  pruneCycles: true,
  honorAliases: true,
} as const;

/**
 * Strip a pnpm peer-disambiguation suffix from a version, e.g.
 * `18.2.0(react@18.2.0)` → `18.2.0`. Snyk's parser usually normalises these
 * but we defensively re-apply to handle exotic cases.
 */
function normaliseVersion(v: string): string {
  const paren = v.indexOf('(');
  return paren === -1 ? v : v.slice(0, paren);
}

interface DepGraphLike {
  getDepPkgs(): readonly { name: string; version?: string }[];
}

function pkgsFromGraph(graph: DepGraphLike): Pkg[] {
  const out: Pkg[] = [];
  for (const dep of graph.getDepPkgs()) {
    if (!dep.version) continue;
    const normalised = normaliseVersion(dep.version);
    // snyk's `UNDEFINED_VERSION` constant — produced when a workspace member's
    // package.json lacks a `version` field. Never a real registry version.
    if (normalised === 'undefined') continue;
    // pnpm `link:...` resolutions and yarn `workspace:...` resolutions point
    // at sibling workspace members, not registry packages. Drop them here; the
    // member-name filter applied later catches the same packages by name, but
    // catching by version too is cheap and keeps the package list clean even
    // if a member's name is somehow missing from the filter set.
    if (normalised.startsWith('link:') || normalised.startsWith('workspace:')) continue;
    out.push({ name: dep.name, version: normalised });
  }
  return out;
}

/**
 * Read a `name` field from a package.json string. Returns `null` if the
 * manifest is malformed or has no name. Used to assemble the set of
 * workspace-member names that must be excluded from the registry check
 * (they're internal `link:`/`workspace:` references, not real npm packages).
 */
function manifestName(manifestContent: string): string | null {
  try {
    const parsed = JSON.parse(manifestContent);
    if (typeof parsed === 'object' && parsed !== null) {
      const name = (parsed as { name?: unknown }).name;
      if (typeof name === 'string' && name.length > 0) return name;
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

/**
 * Discover pnpm workspace member paths from a `pnpm-lock.yaml`. The lockfile's
 * `importers:` section lists every member literally (post-install ground truth),
 * so no glob expansion is required. Returns the importer keys verbatim — `.`
 * is the root, anything else (e.g. `apps/a`) is a member path relative to the
 * lockfile root.
 */
function discoverPnpmImporters(lockfileContent: string): string[] {
  // Tiny line-based scanner — pnpm-lock.yaml's `importers:` section uses
  // two-space-indented keys at the top of the section, which is stable across
  // lockfile versions 6, 7, 9. Avoids pulling in a YAML dependency.
  const importers: string[] = [];
  let inImporters = false;
  for (const line of lockfileContent.split('\n')) {
    if (/^importers:\s*$/.test(line)) {
      inImporters = true;
      continue;
    }
    if (!inImporters) continue;
    if (/^[^\s]/.test(line)) break; // next top-level section
    // Importer keys sit at exactly 2 spaces of indent. They may be quoted
    // (rare), and the line may carry inline content after the colon for empty
    // importers (e.g. `  apps/a: {}` when a member has no deps).
    const m = /^ {2}(?:'([^']+)'|"([^"]+)"|([^\s'":][^\s:]*)):(?:\s|$)/.exec(line);
    if (m) importers.push((m[1] ?? m[2] ?? m[3])!);
  }
  return importers;
}

/**
 * Discover npm workspace member paths from a `package-lock.json`. The lockfile's
 * `packages` section uses `""` for root and member relative paths (e.g.
 * `"apps/a"`) for each workspace member; other keys begin with `node_modules/`.
 * Returns member paths only — the empty-string root is excluded.
 */
function discoverNpmMembers(lockfileContent: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(lockfileContent);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const packages = (parsed as { packages?: unknown }).packages;
  if (typeof packages !== 'object' || packages === null) return [];
  const members: string[] = [];
  for (const key of Object.keys(packages)) {
    if (key === '') continue;
    if (key.startsWith('node_modules/')) continue;
    members.push(key);
  }
  return members;
}

/**
 * Extract the `workspaces` field from a root `package.json`. Accepts both the
 * array form (`["apps/*"]`) and the object form (`{ "packages": [...] }`).
 * Unlike snyk's helper we do not require `private: true` — yarn enforces that
 * at install time, and a lockfile only exists if install succeeded.
 */
function extractWorkspacesField(manifestContent: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestContent);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const ws = (parsed as { workspaces?: unknown }).workspaces;
  if (Array.isArray(ws)) return ws.filter((s): s is string => typeof s === 'string');
  if (typeof ws === 'object' && ws !== null) {
    const packages = (ws as { packages?: unknown }).packages;
    if (Array.isArray(packages)) {
      return packages.filter((s): s is string => typeof s === 'string');
    }
  }
  return [];
}

/**
 * Expand a list of simple globs (single `*` per segment, e.g. `apps/*`) into
 * concrete relative directory paths, using {@link list} to enumerate each
 * intermediate directory. Patterns without `*` are returned as-is (no
 * existence check — the caller will warn-and-skip if the manifest is missing).
 *
 * `**` is not supported; real-world workspace configs use shallow segment
 * globs.
 */
async function expandSimpleGlobs(
  globs: readonly string[],
  list: (path: string) => Promise<string[] | null>,
): Promise<string[]> {
  const out = new Set<string>();
  for (const glob of globs) {
    if (!glob.includes('*')) {
      out.add(glob);
      continue;
    }
    if (glob.includes('**')) continue; // unsupported; skip silently
    const segments = glob.split('/');
    let frontier: string[] = [''];
    for (const seg of segments) {
      const next: string[] = [];
      for (const prefix of frontier) {
        if (seg === '*') {
          const entries = await list(prefix === '' ? '.' : prefix);
          if (!entries) continue;
          for (const e of entries) next.push(prefix === '' ? e : `${prefix}/${e}`);
        } else if (seg.includes('*')) {
          // segment-internal wildcard like `pkg-*` — match against listing
          const re = new RegExp('^' + seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
          const entries = await list(prefix === '' ? '.' : prefix);
          if (!entries) continue;
          for (const e of entries) {
            if (re.test(e)) next.push(prefix === '' ? e : `${prefix}/${e}`);
          }
        } else {
          next.push(prefix === '' ? seg : `${prefix}/${seg}`);
        }
      }
      frontier = next;
    }
    for (const p of frontier) out.add(p);
  }
  return [...out];
}

/**
 * Parse one lockfile + its (possibly multiple) manifests at one side (HEAD
 * or base ref) into a flat list of `(name, version)` pairs. Returns `null`
 * if the format is unrecognised or the lockfile is empty; pushes warnings
 * to `warnings` for recoverable issues (e.g. a missing member manifest).
 *
 * For non-workspace projects this collapses to a single parser call against
 * the root manifest, matching the pre-workspace behaviour.
 */
async function parseSide(opts: {
  kind: LockfileKind;
  lockfileContent: string;
  rootManifestContent: string;
  /** Read a manifest path on this side. Returns null when absent. */
  readManifest(path: string): Promise<string | null>;
  /** List directories at a path on this side. Returns null when absent. */
  listDir(path: string): Promise<string[] | null>;
  /** Label used in warnings, e.g. `"HEAD"` or `"<ref>"`. */
  sideLabel: string;
  warnings: ExtractWarning[];
}): Promise<Pkg[] | null> {
  const { kind, lockfileContent, rootManifestContent } = opts;
  if (lockfileContent.trim() === '') return [];

  // Names of every workspace member's package — these are internal
  // `link:`/`workspace:` references that point at sibling members rather than
  // registry packages, and must be excluded from the final set.
  const memberNames = new Set<string>();
  const rootName = manifestName(rootManifestContent);
  if (rootName) memberNames.add(rootName);

  let collected: Pkg[];

  if (kind === 'pnpm') {
    const version = getPnpmLockfileVersion(lockfileContent);
    const importers = discoverPnpmImporters(lockfileContent);
    const hasMembers = importers.some((i) => i !== '.');
    if (!hasMembers) {
      const graph = await parsePnpmProject(rootManifestContent, lockfileContent, SNYK_PARSE_OPTS_PNPM, version);
      collected = pkgsFromGraph(graph);
    } else {
      collected = [];
      for (const importer of importers) {
        const manifestPath = importer === '.' ? 'package.json' : `${importer}/package.json`;
        const manifest = importer === '.' ? rootManifestContent : await opts.readManifest(manifestPath);
        if (manifest === null) {
          opts.warnings.push({
            message: `Workspace member ${manifestPath} missing at ${opts.sideLabel}; skipping member.`,
          });
          continue;
        }
        const name = manifestName(manifest);
        if (name) memberNames.add(name);
        let graph;
        try {
          graph = await parsePnpmWorkspaceProject(manifest, lockfileContent, SNYK_PARSE_OPTS_PNPM, importer, version);
        } catch (err) {
          opts.warnings.push({
            message: `Failed to parse pnpm workspace member ${importer} at ${opts.sideLabel}: ${errorMessage(err)}`,
          });
          continue;
        }
        for (const pkg of pkgsFromGraph(graph)) collected.push(pkg);
      }
    }
  } else if (kind === 'npm') {
    const members = discoverNpmMembers(lockfileContent);
    const allManifestPaths = ['package.json', ...members.map((m) => `${m}/package.json`)];
    collected = [];
    for (const manifestPath of allManifestPaths) {
      const manifest =
        manifestPath === 'package.json'
          ? rootManifestContent
          : await opts.readManifest(manifestPath);
      if (manifest === null) {
        opts.warnings.push({
          message: `Workspace member ${manifestPath} missing at ${opts.sideLabel}; skipping member.`,
        });
        continue;
      }
      const name = manifestName(manifest);
      if (name) memberNames.add(name);
      let graph;
      try {
        graph = await parseNpmLockV2Project(manifest, lockfileContent, SNYK_PARSE_OPTS_NPM);
      } catch (err) {
        opts.warnings.push({
          message: `Failed to parse npm workspace member ${manifestPath} at ${opts.sideLabel}: ${errorMessage(err)}`,
        });
        continue;
      }
      for (const pkg of pkgsFromGraph(graph)) collected.push(pkg);
    }
  } else {
    // yarn
    const version = getYarnLockfileVersion(lockfileContent);
    const globs = extractWorkspacesField(rootManifestContent);
    const memberPaths =
      globs.length === 0 ? [] : await expandSimpleGlobs(globs, opts.listDir);

    if (version === NodeLockfileVersion.YarnLockV1) {
      if (memberPaths.length === 0) {
        const graph = await parseYarnLockV1Project(
          rootManifestContent,
          lockfileContent,
          SNYK_PARSE_OPTS_YARN_V1,
        );
        collected = pkgsFromGraph(graph);
      } else {
        const manifests: string[] = [rootManifestContent];
        for (const member of memberPaths) {
          const manifestPath = `${member}/package.json`;
          const m = await opts.readManifest(manifestPath);
          if (m === null) {
            opts.warnings.push({
              message: `Workspace member ${manifestPath} missing at ${opts.sideLabel}; skipping member.`,
            });
            continue;
          }
          const name = manifestName(m);
          if (name) memberNames.add(name);
          manifests.push(m);
        }
        let graphs;
        try {
          graphs = await parseYarnLockV1WorkspaceProject(
            lockfileContent,
            manifests,
            SNYK_PARSE_OPTS_YARN_V1_WORKSPACE,
          );
        } catch (err) {
          opts.warnings.push({
            message: `Failed to parse yarn v1 workspace at ${opts.sideLabel}: ${errorMessage(err)}`,
          });
          return [];
        }
        collected = [];
        for (const graph of graphs) {
          for (const pkg of pkgsFromGraph(graph)) collected.push(pkg);
        }
      }
    } else {
      // yarn v2+
      if (memberPaths.length === 0) {
        const graph = await parseYarnLockV2Project(
          rootManifestContent,
          lockfileContent,
          SNYK_PARSE_OPTS_YARN_V2,
        );
        collected = pkgsFromGraph(graph);
      } else {
        const rootDeps = collectRootResolutions(rootManifestContent);
        collected = [];
        const rootGraph = await safeParseYarnV2(
          rootManifestContent,
          lockfileContent,
          { isWorkspacePkg: true, isRoot: true, rootResolutions: rootDeps },
          opts.warnings,
          `<root> at ${opts.sideLabel}`,
        );
        if (rootGraph) for (const pkg of pkgsFromGraph(rootGraph)) collected.push(pkg);

        for (const member of memberPaths) {
          const manifestPath = `${member}/package.json`;
          const memberManifest = await opts.readManifest(manifestPath);
          if (memberManifest === null) {
            opts.warnings.push({
              message: `Workspace member ${manifestPath} missing at ${opts.sideLabel}; skipping member.`,
            });
            continue;
          }
          const name = manifestName(memberManifest);
          if (name) memberNames.add(name);
          const graph = await safeParseYarnV2(
            memberManifest,
            lockfileContent,
            { isWorkspacePkg: true, isRoot: false, rootResolutions: rootDeps },
            opts.warnings,
            `${manifestPath} at ${opts.sideLabel}`,
          );
          if (graph) for (const pkg of pkgsFromGraph(graph)) collected.push(pkg);
        }
      }
    }
  }

  return collected.filter((p) => !memberNames.has(p.name));
}

async function safeParseYarnV2(
  manifestContent: string,
  lockfileContent: string,
  workspaceArgs: { isWorkspacePkg: boolean; isRoot: boolean; rootResolutions: Record<string, string> },
  warnings: ExtractWarning[],
  label: string,
): Promise<DepGraphLike | null> {
  try {
    return await parseYarnLockV2Project(
      manifestContent,
      lockfileContent,
      SNYK_PARSE_OPTS_YARN_V2,
      workspaceArgs,
    );
  } catch (err) {
    warnings.push({
      message: `Failed to parse yarn v2 workspace member ${label}: ${errorMessage(err)}`,
    });
    return null;
  }
}

function collectRootResolutions(manifestContent: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestContent);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const resolutions = (parsed as { resolutions?: unknown }).resolutions;
  if (typeof resolutions !== 'object' || resolutions === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(resolutions)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function packageKey(p: Pkg): string {
  return `${p.name}@${p.version}`;
}

/**
 * Extract the set of `(name, version)` pairs that must be checked against the
 * registry, applying the diff-vs-scan semantics.
 *
 * @param opts.mode `'diff'` to subtract base from head, `'scan'` to use head whole.
 * @param opts.baseRef Required when `mode === 'diff'`. Passed verbatim to the
 *                     {@link FileReader} for base-side reads.
 * @param opts.reader  Abstraction over disk and git. Inject fakes in tests.
 *
 * @example
 * const result = await extractPackagesUnderReview({
 *   mode: 'diff',
 *   baseRef: 'origin/main',
 *   reader: realReader,
 * });
 * console.log(result.setUnderReview); // newly added packages only
 */
export async function extractPackagesUnderReview(opts: {
  mode: 'diff' | 'scan';
  baseRef: string | null;
  reader: FileReader;
}): Promise<ExtractResult> {
  const warnings: ExtractWarning[] = [];
  const unionHead = new Map<string, Pkg>();
  const unionBase = new Map<string, Pkg>();
  const kindsSeen: LockfileKind[] = [];

  for (const spec of KNOWN_LOCKFILES) {
    const headLockfile = await opts.reader.readHead(spec.lockfilePath);
    if (headLockfile === null) continue;

    const headManifest = await opts.reader.readHead(spec.manifestPath);
    if (headManifest === null) {
      warnings.push({
        message: `Found ${spec.lockfilePath} but no ${spec.manifestPath} at HEAD; skipping ${spec.kind}.`,
      });
      continue;
    }

    kindsSeen.push(spec.kind);

    let headPkgs: Pkg[] | null;
    try {
      headPkgs = await parseSide({
        kind: spec.kind,
        lockfileContent: headLockfile,
        rootManifestContent: headManifest,
        readManifest: (p) => opts.reader.readHead(p),
        listDir: (p) => opts.reader.listHeadDir(p),
        sideLabel: 'HEAD',
        warnings,
      });
    } catch (err) {
      warnings.push({ message: `Failed to parse ${spec.lockfilePath} at HEAD: ${errorMessage(err)}` });
      continue;
    }
    if (headPkgs) {
      for (const pkg of headPkgs) unionHead.set(packageKey(pkg), pkg);
    }

    if (opts.mode !== 'diff') continue;
    if (opts.baseRef === null) continue;

    const baseLockfile = await opts.reader.readAtRef(opts.baseRef, spec.lockfilePath);
    if (baseLockfile === null) {
      warnings.push({
        message: `Lockfile ${spec.lockfilePath} is new at HEAD (not present at ${opts.baseRef}); the full HEAD set for this lockfile will be checked.`,
      });
      continue;
    }
    const baseManifest = await opts.reader.readAtRef(opts.baseRef, spec.manifestPath);
    if (baseManifest === null) {
      warnings.push({
        message: `Lockfile ${spec.lockfilePath} present at ${opts.baseRef} but ${spec.manifestPath} is not; assuming base set is empty for this lockfile.`,
      });
      continue;
    }

    let basePkgs: Pkg[] | null;
    try {
      basePkgs = await parseSide({
        kind: spec.kind,
        lockfileContent: baseLockfile,
        rootManifestContent: baseManifest,
        readManifest: (p) => opts.reader.readAtRef(opts.baseRef!, p),
        listDir: (p) => opts.reader.listAtRefDir(opts.baseRef!, p),
        sideLabel: opts.baseRef,
        warnings,
      });
    } catch (err) {
      warnings.push({
        message: `Failed to parse ${spec.lockfilePath} at ${opts.baseRef}: ${errorMessage(err)}; assuming base set is empty for this lockfile.`,
      });
      continue;
    }
    if (basePkgs) {
      for (const pkg of basePkgs) unionBase.set(packageKey(pkg), pkg);
    }
  }

  const setUnderReview: Pkg[] = [];
  if (opts.mode === 'scan') {
    for (const pkg of unionHead.values()) setUnderReview.push(pkg);
  } else {
    for (const [key, pkg] of unionHead) {
      if (!unionBase.has(key)) setUnderReview.push(pkg);
    }
  }

  setUnderReview.sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
  });

  return { setUnderReview, lockfileKindsSeen: kindsSeen, warnings };
}

/**
 * Standard filesystem-backed reader used by the CLI. `readAtRef` shells out to
 * `git show <ref>:<path>`; `listAtRefDir` shells out to `git ls-tree -d`.
 * Methods return `null` when the target is absent (ENOENT, git exit 128);
 * other failures propagate.
 */
export function createFileReader(deps: {
  cwd: string;
  fs: {
    readFile(path: string, encoding: 'utf8'): Promise<string>;
    readdir(path: string, opts: { withFileTypes: true }): Promise<{ name: string; isDirectory(): boolean }[]>;
  };
  exec(cmd: string, args: readonly string[], cwd: string): Promise<{
    stdout: string;
    stderr: string;
    code: number;
  }>;
}): FileReader {
  return {
    async readHead(path: string): Promise<string | null> {
      try {
        return await deps.fs.readFile(`${deps.cwd}/${path}`, 'utf8');
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    async readAtRef(ref: string, path: string): Promise<string | null> {
      const result = await deps.exec('git', ['show', `${ref}:${path}`], deps.cwd);
      if (result.code === 0) return result.stdout;
      // git show returns 128 for missing path-at-ref and for unresolvable refs.
      // Distinguish: if stderr mentions the ref itself ("unknown revision",
      // "bad revision"), surface as a thrown error so the caller exits 2.
      const stderr = result.stderr;
      if (/unknown revision|bad revision|not a valid object name/i.test(stderr)) {
        throw new Error(`git: ${stderr.trim()}`);
      }
      return null;
    },
    async listHeadDir(path: string): Promise<string[] | null> {
      try {
        const entries = await deps.fs.readdir(`${deps.cwd}/${path}`, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    async listAtRefDir(ref: string, path: string): Promise<string[] | null> {
      // `git ls-tree -d --name-only <ref> <path>/` lists immediate directory
      // children of <path>. Trailing slash and `-d` together restrict the
      // output to directories one level down.
      const target = path === '.' || path === '' ? `${ref}:` : `${ref}:${path}/`;
      const result = await deps.exec('git', ['ls-tree', '-d', '--name-only', target], deps.cwd);
      if (result.code !== 0) {
        const stderr = result.stderr;
        if (/unknown revision|bad revision|not a valid object name/i.test(stderr)) {
          throw new Error(`git: ${stderr.trim()}`);
        }
        return null;
      }
      // Output is one path per line. For nested paths (`apps/foo/bar`) we want
      // just the leaf segment, since the caller asked for children of <path>.
      const prefix = path === '.' || path === '' ? '' : `${path}/`;
      return result.stdout
        .split('\n')
        .filter((s) => s.length > 0)
        .map((s) => (s.startsWith(prefix) ? s.slice(prefix.length) : s));
    },
  };
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
