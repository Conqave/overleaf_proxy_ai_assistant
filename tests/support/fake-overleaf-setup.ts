import { build } from 'esbuild';
import type { TestProject } from 'vitest/node';
import { TestFixtureError } from './test-errors';

declare module 'vitest' {
  export interface ProvidedContext {
    fakeOverleafScript: string;
  }
}

export default async function setup(project: TestProject): Promise<void> {
  const page = await build({
    entryPoints: ['tests/support/fake-overleaf-page.ts'],
    bundle: true,
    format: 'iife',
    target: 'es2022',
    write: false,
    logLevel: 'error',
  });
  const [script] = page.outputFiles;
  if (!script) throw new TestFixtureError('esbuild produced no fake Overleaf page script');
  project.provide('fakeOverleafScript', script.text);
}
