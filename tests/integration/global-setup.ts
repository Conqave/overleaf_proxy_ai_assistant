import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    fakeOverleafScript: string;
  }
}

export default async function setup(project: TestProject): Promise<void> {
  execFileSync('node', ['scripts/build.mjs'], { stdio: 'inherit' });
  const page = await build({
    entryPoints: ['tests/support/fake-overleaf-page.ts'],
    bundle: true,
    format: 'iife',
    target: 'es2022',
    write: false,
    logLevel: 'error',
  });
  const [script] = page.outputFiles;
  if (!script) throw new Error('esbuild produced no fake Overleaf page script');
  project.provide('fakeOverleafScript', script.text);
}
