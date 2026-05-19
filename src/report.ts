import type { Pkg } from './filters.js';
import type { LookupResult } from './registry.js';
import type { ExtractWarning, LockfileKind } from './extract.js';

/**
 * One package that failed the age check. Sorted ascending by age in the
 * final output so the youngest (most suspicious) is listed first.
 */
export interface Offender {
  pkg: Pkg;
  ageHours: number;
  publishedAt: Date;
}

export interface RenderInput {
  mode: 'diff' | 'scan';
  minAgeHours: number;
  totalUnderReview: number;
  lockfileKinds: LockfileKind[];
  extractWarnings: ExtractWarning[];
  lookups: LookupResult[];
  now: Date;
}

export interface RenderOutput {
  /** Lines written to stdout (summary, success/failure header). */
  stdoutLines: string[];
  /** Lines written to stderr (warnings, offenders, hint). */
  stderrLines: string[];
  /** Offenders, sorted ascending by age. */
  offenders: Offender[];
  /** Per-package warnings extracted from the lookup results. */
  warnings: { pkg: Pkg; reason: string }[];
}

/**
 * Build the human-readable summary line for the run. Names the mode and the
 * lockfile files involved (for scan mode) so the output is unambiguous.
 */
function buildSummaryLine(input: RenderInput): string {
  const n = input.totalUnderReview;
  if (input.mode === 'diff') {
    return `Found ${n} newly added package@version pair(s).`;
  }
  const files =
    input.lockfileKinds.length === 0
      ? '(no lockfiles)'
      : input.lockfileKinds
          .map((k) =>
            k === 'pnpm'
              ? 'pnpm-lock.yaml'
              : k === 'npm'
                ? 'package-lock.json'
                : 'yarn.lock',
          )
          .join(', ');
  return `Scanning ${n} package@version pair(s) in ${files}.`;
}

/**
 * Compute the rendered output for one run, deterministically. Pure function —
 * no I/O, no `Date.now()` access. The CLI entry passes `now` explicitly so
 * tests can pin time.
 *
 * Side-effect ordering for the caller:
 *   1. write `stdoutLines[0]` (summary)
 *   2. write each `stderrLines` line
 *   3. on success, write the success line (last entry of stdoutLines)
 */
export function renderReport(input: RenderInput): RenderOutput {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  stdoutLines.push(buildSummaryLine(input));

  const warnings: { pkg: Pkg; reason: string }[] = [];
  const offenders: Offender[] = [];

  for (const r of input.lookups) {
    if (r.kind === 'warning') {
      warnings.push({ pkg: r.pkg, reason: r.reason });
      continue;
    }
    const ageMs = input.now.getTime() - r.publishedAt.getTime();
    const ageHours = ageMs / 3_600_000;
    if (ageMs < input.minAgeHours * 3_600_000) {
      offenders.push({ pkg: r.pkg, ageHours, publishedAt: r.publishedAt });
    }
  }
  offenders.sort((a, b) => a.ageHours - b.ageHours);

  for (const w of input.extractWarnings) {
    stderrLines.push(`⚠️  ${w.message}`);
  }

  if (warnings.length > 0) {
    stderrLines.push('');
    stderrLines.push(`⚠️  ${warnings.length} warning(s):`);
    for (const w of warnings) {
      stderrLines.push(`   ${w.pkg.name}@${w.pkg.version}: ${w.reason}`);
    }
  }

  if (offenders.length === 0) {
    stdoutLines.push(`✅ All packages are at least ${input.minAgeHours}h old.`);
  } else {
    stderrLines.push('');
    stderrLines.push(`❌ ${offenders.length} package(s) younger than ${input.minAgeHours}h:`);
    stderrLines.push('');
    for (const o of offenders) {
      const ageStr = o.ageHours.toFixed(1);
      stderrLines.push(
        `   ${o.pkg.name}@${o.pkg.version}  —  ${ageStr}h old  (${o.publishedAt.toISOString()})`,
      );
    }
    stderrLines.push('');
    stderrLines.push(
      `Allow via --allow <name>,<name> (or ALLOWED_PACKAGES=…), or wait until they age past ${input.minAgeHours}h.`,
    );
  }

  return { stdoutLines, stderrLines, offenders, warnings };
}

/**
 * A throttled, TTY-aware progress writer. On a TTY, overwrites a single line
 * via `\r`. Off TTY, emits each tick as a new line. Throttled to one update
 * per `intervalMs` (default 2000ms) — runs that finish before the first tick
 * produce no output, which is the desired behaviour for small scans.
 *
 * The writer ignores ticks while `disabled` is true so `--quiet` can suppress
 * progress without affecting warnings/offenders.
 */
export class ProgressWriter {
  private readonly startedAt: number;
  private lastEmittedAt: number | null = null;
  private hasWritten = false;
  private finalised = false;

  constructor(
    private readonly opts: {
      stream: { write(s: string): void; isTTY?: boolean };
      now: () => number;
      intervalMs?: number;
      disabled?: boolean;
    },
  ) {
    this.startedAt = this.opts.now();
  }

  tick(done: number, total: number): void {
    if (this.opts.disabled || this.finalised) return;
    const now = this.opts.now();
    const interval = this.opts.intervalMs ?? 2000;
    // Skip until the first tick after the initial warmup window.
    if (now - this.startedAt < interval) return;
    if (this.lastEmittedAt !== null && now - this.lastEmittedAt < interval) return;
    this.lastEmittedAt = now;
    const line = `Checked ${done}/${total}…`;
    if (this.opts.stream.isTTY) {
      this.opts.stream.write(`\r\x1b[2K${line}`);
    } else {
      this.opts.stream.write(`${line}\n`);
    }
    this.hasWritten = true;
  }

  /** Clear any in-place progress before subsequent output. */
  finalise(): void {
    if (this.finalised) return;
    this.finalised = true;
    if (this.hasWritten && this.opts.stream.isTTY) {
      this.opts.stream.write('\r\x1b[2K');
    }
  }
}
