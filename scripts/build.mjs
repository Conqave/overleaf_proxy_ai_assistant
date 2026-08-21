import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const rawCss = {
  name: 'raw-css',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\.css\?raw$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'raw-css',
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: 'raw-css' }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

await build({
  entryPoints: ['src/bootstrap/main.ts'],
  outfile: 'dist/overleaf-ai-assistant.js',
  bundle: true,
  format: 'iife',
  target: 'es2022',
  plugins: [rawCss],
  legalComments: 'none',
  logLevel: 'info',
});
