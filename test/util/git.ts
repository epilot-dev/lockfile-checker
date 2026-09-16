import { spawn } from 'node:child_process';

/**
 * Minimal spawn-based exec with the same shape as `bin.ts`'s `runGit`, for
 * tests that need a real git repository rather than a fake.
 */
export function runGit(
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

/** Run a git command that must succeed; throws with stderr otherwise. */
export async function git(args: readonly string[], cwd: string): Promise<string> {
  const r = await runGit('git', args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}
