import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TestFixtureError } from '../support/test-errors';

const SRC = path.resolve(import.meta.dirname, '../../src');

const ALLOWED: Record<string, readonly string[]> = {
  domain: ['domain'],
  ports: ['ports', 'domain'],
  application: ['application', 'ports', 'domain'],
  infrastructure: ['infrastructure', 'ports', 'domain'],
  presentation: ['presentation', 'application', 'domain'],
  bootstrap: ['bootstrap', 'presentation', 'application', 'infrastructure', 'ports', 'domain'],
};

const STATIC_REFERENCE =
  /^\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
const DYNAMIC_REFERENCE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

function importsOf(source: string): { target: string; typeOnly: boolean }[] {
  const staticReferences = [...source.matchAll(STATIC_REFERENCE)].map((m) => ({
    target: m[2]!,
    typeOnly: m[1] !== undefined,
  }));
  const dynamicReferences = [...source.matchAll(DYNAMIC_REFERENCE)].map((m) => ({
    target: m[1]!,
    typeOnly: false,
  }));
  return [...staticReferences, ...dynamicReferences];
}

const layerOf = (file: string): string => {
  const [layer] = path.relative(SRC, file).split(path.sep);
  if (layer === undefined) throw new TestFixtureError(`${file} is outside ${SRC}`);
  return layer;
};
const tsFiles = sourceFiles(SRC);

const edges = tsFiles.flatMap((file) =>
  importsOf(readFileSync(file, 'utf8')).map(({ target, typeOnly }) => ({
    from: path.relative(SRC, file),
    target,
    typeOnly,
    layer: target.startsWith('.') ? layerOf(path.resolve(path.dirname(file), target)) : null,
  })),
);

describe('dependency rules', () => {
  it('every source file belongs to a known layer', () => {
    expect(tsFiles.map(layerOf).filter((layer) => !(layer in ALLOWED))).toEqual([]);
  });

  it('recognises every form of module reference', () => {
    const source = [
      "import { a } from './a';",
      "import type { B } from './b';",
      "import './c';",
      "import {\n  d,\n} from './d';",
      "export { e } from './e';",
      "export type { F } from './f';",
      "export * from './g';",
      "const h = await import('./h');",
      "export const i = 'not a module';",
    ].join('\n');
    expect(importsOf(source)).toEqual([
      { target: './a', typeOnly: false },
      { target: './b', typeOnly: true },
      { target: './c', typeOnly: false },
      { target: './d', typeOnly: false },
      { target: './e', typeOnly: false },
      { target: './f', typeOnly: true },
      { target: './g', typeOnly: false },
      { target: './h', typeOnly: false },
    ]);
  });

  it('imports point only inward', () => {
    const violations = edges
      .filter((edge) => edge.layer !== null)
      .filter((edge) => !ALLOWED[layerOf(path.join(SRC, edge.from))]!.includes(edge.layer!))
      .map((edge) => `${edge.from} -> ${edge.target}`);
    expect(violations).toEqual([]);
  });

  it('src has no third-party runtime imports', () => {
    expect(
      edges
        .filter((edge) => edge.layer === null && !edge.typeOnly)
        .map((e) => `${e.from} -> ${e.target}`),
    ).toEqual([]);
  });

  it('only the Overleaf adapter knows CodeMirror, and only its types', () => {
    const leaking = edges
      .filter((edge) => edge.target.startsWith('@codemirror/'))
      .filter((edge) => !edge.from.startsWith(`infrastructure${path.sep}overleaf${path.sep}`))
      .map((e) => `${e.from} -> ${e.target}`);
    expect(leaking).toEqual([]);
  });

  it('only the Ollama adapter knows the Ollama wire format and fetch', () => {
    const leaking = tsFiles
      .filter((file) => !file.includes(`${path.sep}infrastructure${path.sep}ollama${path.sep}`))
      .filter((file) => !file.includes(`${path.sep}bootstrap${path.sep}`))
      .filter((file) => /\bfetch\(|keep_alive|\/api\/generate/.test(readFileSync(file, 'utf8')));
    expect(leaking.map((file) => path.relative(SRC, file))).toEqual([]);
  });
});
