import builtins from 'builtin-modules';
import esbuild from 'esbuild';
import process from 'node:process';

const production = process.argv[2] === 'production';

const banner = `/*
Vault Relay - self-hosted Obsidian sync.
This file is generated. Source: https://github.com/roylet/obsidiansync
*/
`;

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'main.js',
  format: 'cjs',
  target: 'es2018',
  // The plugin must load on iOS and Android, where there is no Node runtime.
  // Marking the builtins external is a safety net: nothing in src/ imports
  // them, and a stray import surfaces here as an unresolved module at runtime
  // rather than silently shipping a desktop-only bundle.
  platform: 'browser',
  external: ['obsidian', 'electron', ...builtins],
  banner: { js: banner },
  sourcemap: production ? false : 'inline',
  minify: production,
  treeShaking: true,
  logLevel: 'info',
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
