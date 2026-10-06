// Production build: one ESM file, dist/server.js, run by start.sh.
//
// Workspace packages (`@ai-med/*`) are bundled from their TypeScript source,
// so tsx (dev and tests), Vite (frontend) and esbuild (here) all read the same
// `src/*.ts` and no workspace needs a dist step of its own. Every other bare
// specifier stays external and resolves from node_modules at runtime, exactly
// as `--packages=external` did; native and SDK packages (better-sqlite3, pg,
// openai) are never bundled. A workspace's runtime dependencies are therefore
// declared in its own package.json. CI checks that dist/server.js names no
// `@ai-med/` import and parses under plain node.
import { build } from 'esbuild';

const inlineWorkspace = {
  name: 'inline-workspace',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (a) =>
      a.path.startsWith('@ai-med/') ? undefined : { path: a.path, external: true });
  },
};

await build({
  entryPoints: ['src/server.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/server.js',
  plugins: [inlineWorkspace],
});
