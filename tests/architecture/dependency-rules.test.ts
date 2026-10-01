import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { groupOf } from '../support/guards';
import { TestFixtureError } from '../support/test-errors';

const SRC = path.resolve(import.meta.dirname, '../../src');

const ALLOWED: ReadonlyMap<string, readonly string[]> = new Map([
  ['domain', ['domain']],
  ['ports', ['ports', 'domain']],
  ['application', ['application', 'ports', 'domain']],
  ['infrastructure', ['infrastructure', 'ports', 'domain']],
  ['presentation', ['presentation', 'application', 'domain']],
  ['bootstrap', ['bootstrap', 'presentation', 'application', 'infrastructure', 'ports', 'domain']],
]);

function allowedLayersOf(layer: string): readonly string[] {
  const allowed = ALLOWED.get(layer);
  if (allowed === undefined) throw new TestFixtureError(`${layer} is no known layer`);
  return allowed;
}

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
    target: groupOf(m, 2, 'static module reference'),
    typeOnly: m[1] !== undefined,
  }));
  const dynamicReferences = [...source.matchAll(DYNAMIC_REFERENCE)].map((m) => ({
    target: groupOf(m, 1, 'dynamic module reference'),
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
    expect(tsFiles.map(layerOf).filter((layer) => !ALLOWED.has(layer))).toEqual([]);
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
      .flatMap(({ layer, ...edge }) => (layer === null ? [] : [{ ...edge, layer }]))
      .filter((edge) => !allowedLayersOf(layerOf(path.join(SRC, edge.from))).includes(edge.layer))
      .map((edge) => `${edge.from} -> ${edge.target}`);
    expect(violations).toEqual([]);
  });

  it('src imports third-party code at runtime only in the Markdown renderer', () => {
    expect(
      edges
        .filter((edge) => edge.layer === null && !edge.typeOnly)
        .map((e) => `${e.from} -> ${e.target}`),
    ).toEqual([
      `presentation${path.sep}markdown-renderer.ts -> dompurify`,
      `presentation${path.sep}markdown-renderer.ts -> marked`,
    ]);
  });

  it('only the Overleaf adapter knows CodeMirror, and only its types', () => {
    const leaking = edges
      .filter((edge) => edge.target.startsWith('@codemirror/'))
      .filter((edge) => !edge.from.startsWith(`infrastructure${path.sep}overleaf${path.sep}`))
      .map((e) => `${e.from} -> ${e.target}`);
    expect(leaking).toEqual([]);
  });

  it('only the Ollama adapter knows the Ollama wire format', () => {
    const leaking = tsFiles
      .filter((file) => !file.includes(`${path.sep}infrastructure${path.sep}ollama${path.sep}`))
      .filter((file) => /keep_alive|\/api\/generate/.test(readFileSync(file, 'utf8')));
    expect(leaking.map((file) => path.relative(SRC, file))).toEqual([]);
  });

  it('only the Ollama and Overleaf adapters and the bootstrap use fetch', () => {
    const fetching = [
      `${path.sep}infrastructure${path.sep}ollama${path.sep}`,
      `${path.sep}infrastructure${path.sep}overleaf${path.sep}`,
      `${path.sep}bootstrap${path.sep}`,
    ];
    const leaking = tsFiles
      .filter((file) => !fetching.some((dir) => file.includes(dir)))
      .filter((file) => /\bfetch\(/.test(readFileSync(file, 'utf8')));
    expect(leaking.map((file) => path.relative(SRC, file))).toEqual([]);
  });
});
