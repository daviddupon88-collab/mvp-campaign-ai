import fs from 'fs';
import path from 'path';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '../config';

const LOCALES_DIR = path.join(__dirname, '..', 'locales');

function namespacesFor(locale: string): string[] {
  return fs.readdirSync(path.join(LOCALES_DIR, locale)).filter((f) => f.endsWith('.json'));
}

function flattenKeys(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([key, value]) =>
    flattenKeys(value, prefix ? `${prefix}.${key}` : key),
  );
}

function loadNamespace(locale: string, file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, file), 'utf-8'));
}

describe('locale completeness', () => {
  const referenceNamespaces = namespacesFor(DEFAULT_LOCALE);

  it(`${DEFAULT_LOCALE} (source of truth) has at least one namespace file`, () => {
    expect(referenceNamespaces.length).toBeGreaterThan(0);
  });

  for (const locale of SUPPORTED_LOCALES) {
    describe(locale, () => {
      it('has exactly the same namespace files as the default locale', () => {
        expect(namespacesFor(locale).sort()).toEqual(referenceNamespaces.sort());
      });

      for (const file of referenceNamespaces) {
        it(`${file} has the exact same keys as ${DEFAULT_LOCALE}, no empty/undefined values`, () => {
          const reference = loadNamespace(DEFAULT_LOCALE, file);
          const target = loadNamespace(locale, file);

          const referenceKeys = flattenKeys(reference).sort();
          const targetKeys = flattenKeys(target).sort();
          expect(targetKeys).toEqual(referenceKeys);

          for (const key of targetKeys) {
            const value = key.split('.').reduce<any>((acc, part) => acc?.[part], target);
            expect(value === undefined || value === null || value === '').toBe(false);
          }
        });
      }
    });
  }
});
