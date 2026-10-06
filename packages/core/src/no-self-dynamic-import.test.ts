import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A runtime import() of core's own module makes esbuild wrap every module of the native bundle lazily (1,300 of them, about
// 70 ms more to the Android app's first content on the S23; it also left index.ts without init_store). Only the locale
// loaders may import lazily. A module that cannot be imported statically registers itself instead
// (store-reference-batch-modules.ts).
describe('core source', () => {
    it('never imports its own modules at run time, except the locale loaders', () => {
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) { walk(path); continue; }
                if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
                const code = readFileSync(path, 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
                for (const match of code.matchAll(/(?<![\w.])import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
                    // `typeof import('./x')` and `: import('./x').T` are types, not loads.
                    const before = code.slice(Math.max(0, match.index - 8), match.index);
                    if (/typeof\s*$|[:<,|]\s*$/.test(before)) continue;
                    if (/^\.\/locales\//.test(match[1])) continue;
                    offenders.push(`${path}: ${match[0]}`);
                }
            }
        };
        walk(import.meta.dirname);
        expect(offenders).toEqual([]);
    });
});
