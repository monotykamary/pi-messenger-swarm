/**
 * Guards the pnpm supply-chain policy in pnpm-workspace.yaml.
 *
 * pnpm only honours ONE `minimumReleaseAgeExclude` entry per package name:
 * when the same package is listed twice (e.g. `pkg@1.0.0` and `pkg@1.1.0`),
 * the later version is silently ignored and `pnpm install --frozen-lockfile`
 * fails CI with ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION until the release ages
 * past the cutoff. Additional versions must be merged into a single entry
 * with `||` (e.g. `pkg@1.0.0 || 1.1.0`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE = fs.readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf-8');
const LOCKFILE = fs.readFileSync(path.join(ROOT, 'pnpm-lock.yaml'), 'utf-8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
  devDependencies: Record<string, string>;
};

function readExcludeEntries(): Array<{ name: string; versions: string[] }> {
  const lines = WORKSPACE.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'minimumReleaseAgeExclude:');
  if (start === -1) return [];
  const entries: Array<{ name: string; versions: string[] }> = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^\s+-\s+['"]?(.+?)['"]?\s*$/.exec(line);
    if (!match) break;
    const spec = match[1];
    const at = spec.lastIndexOf('@');
    const name = at > 0 ? spec.slice(0, at) : spec;
    const versions =
      at > 0
        ? spec
            .slice(at + 1)
            .split('||')
            .map((v) => v.trim())
        : [];
    entries.push({ name, versions });
  }
  return entries;
}

describe('pnpm-workspace.yaml supply-chain policy', () => {
  const entries = readExcludeEntries();

  it('lists each package at most once in minimumReleaseAgeExclude', () => {
    const names = entries.map((entry) => entry.name);
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    expect(duplicates).toEqual([]);
  });

  it('excludes the pinned Pi host packages that the lockfile resolves', () => {
    const piVersion = MANIFEST.devDependencies['@earendil-works/pi-coding-agent'];
    // pnpm honours the first entry per package name, so check exactly that one.
    const honoured = entries.filter(
      (entry, index) => entries.findIndex((e) => e.name === entry.name) === index
    );
    expect(honoured.length).toBeGreaterThan(0);
    for (const { name, versions } of honoured) {
      // Only check packages that the lockfile actually resolves at the pinned host version.
      if (!LOCKFILE.includes(`${name}@${piVersion}`)) continue;
      expect(versions, `${name} must exclude the pinned ${piVersion}`).toContain(piVersion);
    }
  });
});
