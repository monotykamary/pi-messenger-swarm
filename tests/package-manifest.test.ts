import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('package manifest', () => {
  it('does not run dev-only hooks during consumer install', () => {
    const packageJsonPath = path.join(import.meta.dirname, '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.postinstall).toBeUndefined();
    expect(packageJson.scripts?.prepare).toBe('simple-git-hooks');
  });
});
