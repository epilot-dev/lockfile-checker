/**
 * Matches a version string that begins with a semver-shaped MAJOR.MINOR.PATCH.
 * Used to reject lockfile entries whose version is a non-registry reference
 * such as `workspace:*`, `link:../x`, `file:./bar.tgz`, or `git+https://…`.
 */
const SEMVER_PREFIX = /^\d+\.\d+\.\d+/;

/**
 * A single `(name, version)` pair extracted from a lockfile, with the name
 * already de-aliased (`npm:bar@1.0.0` → name = `bar`).
 */
export interface Pkg {
  name: string;
  version: string;
}

/**
 * Returns true if a package should be excluded from the registry check.
 *
 * Exclusion rules (any one triggers exclusion):
 * 1. The exact package name is in `allowedPackages`.
 * 2. The package is scoped (`@scope/name`) and its scope is in `allowedScopes`.
 * 3. The version does not start with a semver `MAJOR.MINOR.PATCH` prefix —
 *    catches `workspace:*`, `link:`, `file:`, `git+…`, and similar.
 *
 * Workspace members of the host repo are filtered out at extract time
 * (see {@link ../extract.ts}), not here.
 *
 * @example
 * isExcluded({ name: 'react', version: '18.2.0' }, new Set(), new Set()); // false
 * isExcluded({ name: 'react', version: '18.2.0' }, new Set(['react']), new Set()); // true
 * isExcluded({ name: '@epilot/foo', version: '1.0.0' }, new Set(), new Set(['@epilot'])); // true
 * isExcluded({ name: 'pkg', version: 'workspace:*' }, new Set(), new Set()); // true
 */
export function isExcluded(
  pkg: Pkg,
  allowedPackages: ReadonlySet<string>,
  allowedScopes: ReadonlySet<string>,
): boolean {
  if (allowedPackages.has(pkg.name)) return true;

  if (pkg.name.startsWith('@')) {
    const slash = pkg.name.indexOf('/');
    if (slash > 0) {
      const scope = pkg.name.slice(0, slash);
      if (allowedScopes.has(scope)) return true;
    }
  }

  if (!SEMVER_PREFIX.test(pkg.version)) return true;

  return false;
}

/**
 * Partition a list of packages into the set that must be checked against
 * the registry and the set that was filtered out.
 *
 * Stable order: the returned `checked` array preserves the input order, and
 * duplicates (same `name@version`) are collapsed.
 */
export function applyFilters(
  pkgs: readonly Pkg[],
  allowedPackages: ReadonlySet<string>,
  allowedScopes: ReadonlySet<string>,
): { checked: Pkg[]; excluded: Pkg[] } {
  const checked: Pkg[] = [];
  const excluded: Pkg[] = [];
  const seen = new Set<string>();

  for (const pkg of pkgs) {
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (isExcluded(pkg, allowedPackages, allowedScopes)) {
      excluded.push(pkg);
    } else {
      checked.push(pkg);
    }
  }

  return { checked, excluded };
}
