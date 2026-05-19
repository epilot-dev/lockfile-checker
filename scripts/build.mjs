#!/usr/bin/env node
import { build } from 'esbuild';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const out = join(root, 'dist', 'index.cjs');

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

await build({
  entryPoints: [join(root, 'src', 'bin.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  target: 'node20',
  // CJS because snyk-nodejs-lockfile-parser uses __dirname and dynamic
  // require() internally; ESM bundling breaks both.
  format: 'cjs',
  minify: false,
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
  define: {
    __LQ_VERSION__: JSON.stringify(pkg.version),
  },
  external: [],
  logLevel: 'info',
});

await chmod(out, 0o755);

const versionStamp = `// @epilot/lockfile-checker v${pkg.version}\n`;
const built = await readFile(out, 'utf8');
await writeFile(
  out,
  built.replace('#!/usr/bin/env node\n', `#!/usr/bin/env node\n${versionStamp}`),
);
