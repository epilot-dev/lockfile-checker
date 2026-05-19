import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';

import { main, type Deps } from './index.js';
import { createFileReader } from './extract.js';
import type { FetchFn } from './registry.js';

/**
 * Version string. Replaced at build time by esbuild's `define` with the
 * package.json `version` field. Falls back to `0.0.0` if the bundle is run
 * without that substitution (e.g. via tsx in development).
 */
declare const __LQ_VERSION__: string;
const VERSION =
  typeof __LQ_VERSION__ === 'string' ? __LQ_VERSION__ : '0.0.0-dev';

/* v8 ignore start -- runtime wiring: shells out to git, calls process.exit; exercised by the bin smoke test */

function runGit(
  cmd: string,
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutBufs: Buffer[] = [];
    const stderrBufs: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => stdoutBufs.push(b));
    child.stderr.on('data', (b: Buffer) => stderrBufs.push(b));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(stdoutBufs).toString('utf8'),
        stderr: Buffer.concat(stderrBufs).toString('utf8'),
        code: code ?? 0,
      });
    });
  });
}

async function entry(): Promise<void> {
  const cwd = process.cwd();
  const reader = createFileReader({
    cwd,
    fs: {
      readFile: (p, e) => readFile(p, e),
      readdir: (p, o) => readdir(p, o),
    },
    exec: runGit,
  });
  const deps: Deps = {
    argv: process.argv.slice(2),
    env: process.env,
    cwd,
    reader,
    fetch: ((url: string, init?: { signal?: AbortSignal }) =>
      globalThis.fetch(url, init) as unknown as ReturnType<FetchFn>) as FetchFn,
    now: () => new Date(),
    stdout: { write: (s) => void process.stdout.write(s), isTTY: process.stdout.isTTY },
    stderr: { write: (s) => void process.stderr.write(s), isTTY: process.stderr.isTTY },
    version: VERSION,
  };
  const code = await main(deps);
  process.exit(code);
}

entry().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
/* v8 ignore stop */
