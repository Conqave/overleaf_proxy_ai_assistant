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

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|css)$/.test(entry.name) ? [full] : [];
  });
}

const layerOf = (file: string): string => {
  const [layer] = path.relative(SRC, file).split(path.sep);
  if (layer === undefined) throw new TestFixtureError(`${file} is outside ${SRC}`);
  return layer;
};
const files = sourceFiles(SRC);
const tsFiles = files.filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'));

const edges = tsFiles.flatMap((file) =>
  [...readFileSync(file, 'utf8').matchAll(/^import\s(type\s)?[^'"]*['"]([^'"]+)['"]/gm)].map(
    (m) => {
      const target = m[2]!;
      return {
        from: path.relative(SRC, file),
        target,
        typeOnly: m[1] !== undefined,
        layer: target.startsWith('.') ? layerOf(path.resolve(path.dirname(file), target)) : null,
      };
    },
  ),
);

describe('dependency rules', () => {
  it('every source file belongs to a known layer', () => {
    const unknown = tsFiles.map(layerOf).filter((layer) => !(layer in ALLOWED));
    expect(unknown.filter((layer) => !layer.endsWith('.d.ts'))).toEqual([]);
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
