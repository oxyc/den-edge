import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sourcePhrases as spanish } from '../src/lib/messages/phrases/es';
import { sourcePhrases as swedish } from '../src/lib/messages/phrases/sv';
import { localizeMarkup } from './localize-markup';
import { pseudoLocalize } from './pseudo-locale';
import { phraseId } from '../src/lib/messages/phraseCatalog';
import { ENGLISH_MESSAGES } from '../src/lib/messages/en';
import { messages as spanishMessages } from '../src/lib/messages/es';
import { messages as swedishMessages } from '../src/lib/messages/sv';
import { PARAMETER_FALLBACKS } from '../src/lib/messages/parameters';
import { parameters as spanishParameters } from '../src/lib/messages/parameters/es';
import { parameters as swedishParameters } from '../src/lib/messages/parameters/sv';

const INTERNAL_STATE = new Set(['lost', 'engine', 'unsupported', 'protocol', 'source']);

describe('UI translation coverage', () => {
  it('compiles markup text, accessibility copy, and conditional output through the phrase catalog', () => {
    const source = `<script>let ready = true;</script>
      <button aria-label="More">Continue Watching</button>
      <p>{ready ? 'Downloads' : 'Home'}</p>`;
    const result = localizeMarkup().markup({
      content: source,
      filename: `${process.cwd()}/src/TranslationFixture.svelte`,
    });

    expect(result.code).toContain('i18n.phrase(');
    expect(result.code).toContain('"More"');
    expect(result.code).toContain('"Continue Watching"');
    expect(result.code).toContain('"Downloads"');
    expect(result.code).toContain('"Home"');
  });

  it('imports the i18n binding when a component imports only another language helper', () => {
    const source = `<script>import { setInterfaceLanguage } from './lib/i18n.svelte';</script>
      <button>Downloads</button>`;
    const result = localizeMarkup().markup({
      content: source,
      filename: `${process.cwd()}/src/TranslationFixture.svelte`,
    });

    expect(result.code).toContain('import { setInterfaceLanguage }');
    expect(result.code).toContain('import { i18n } from "./lib/i18n.svelte"');
    expect(result.code).toContain('i18n.phrase("Downloads")');
  });

  it('keeps Spanish and Swedish catalogs complete and translates prominent navigation and shelves', () => {
    expect(Object.keys(spanish)).toEqual(Object.keys(swedish));
    expect(spanish).toMatchObject({
      More: 'Más',
      'Continue Watching': 'Seguir viendo',
      Downloads: 'Descargas',
      Play: 'Reproducir',
    });
    expect(swedish).toMatchObject({
      More: 'Mer',
      'Continue Watching': 'Fortsätt titta',
      Downloads: 'Hämtningar',
      Play: 'Spela',
    });
  });

  it('keeps stable phrase ids collision-free and parameter placeholders identical in every catalog', () => {
    const owners = new Map<number, string>();
    for (const english of Object.keys(spanish)) {
      const id = phraseId(english);
      expect(owners.get(id), `phrase id ${id}`).toBeUndefined();
      owners.set(id, english);
    }
    const placeholders = (message: string) =>
      [...message.matchAll(/\{([A-Za-z]\w*)\}/g)].map((m) => m[1]).sort();
    expect(Object.keys(spanishMessages)).toEqual(Object.keys(ENGLISH_MESSAGES));
    expect(Object.keys(swedishMessages)).toEqual(Object.keys(ENGLISH_MESSAGES));
    for (const id of Object.keys(ENGLISH_MESSAGES) as (keyof typeof ENGLISH_MESSAGES)[]) {
      expect(placeholders(spanishMessages[id]), `Spanish ${id}`).toEqual(
        placeholders(ENGLISH_MESSAGES[id]),
      );
      expect(placeholders(swedishMessages[id]), `Swedish ${id}`).toEqual(
        placeholders(ENGLISH_MESSAGES[id]),
      );
    }
    expect(Object.keys(spanishParameters)).toEqual(Object.keys(PARAMETER_FALLBACKS));
    expect(Object.keys(swedishParameters)).toEqual(Object.keys(PARAMETER_FALLBACKS));
    for (const id of Object.keys(PARAMETER_FALLBACKS) as (keyof typeof PARAMETER_FALLBACKS)[]) {
      expect(placeholders(spanishParameters[id]), `Spanish ${id}`).toEqual(
        placeholders(PARAMETER_FALLBACKS[id]),
      );
      expect(placeholders(swedishParameters[id]), `Swedish ${id}`).toEqual(
        placeholders(PARAMETER_FALLBACKS[id]),
      );
    }
  });

  it('can pseudo-localize every catalog entry while preserving parameters and expansion pressure', () => {
    for (const message of [
      ...Object.keys(spanish),
      ...Object.values(ENGLISH_MESSAGES),
      ...Object.values(PARAMETER_FALLBACKS),
    ]) {
      const pseudo = pseudoLocalize(message);
      expect(pseudo.length).toBeGreaterThan(message.length);
      expect(pseudo.match(/\{[A-Za-z]\w*\}/g) ?? []).toEqual(
        message.match(/\{[A-Za-z]\w*\}/g) ?? [],
      );
    }
  });

  it('has a translation for every static phrase compiled from shipped Svelte screens', () => {
    const root = join(process.cwd(), 'src');
    const files = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.svelte'))
      .map((entry) => join(entry.parentPath, entry.name));
    const found = new Set<string>();
    for (const filename of files) {
      const result = localizeMarkup().markup({ content: readFileSync(filename, 'utf8'), filename });
      for (const match of result.code.matchAll(/i18n\.phrase\(("(?:[^"\\]|\\.)*")\)/g))
        found.add(JSON.parse(match[1]));
    }
    const missing = [...found].filter((phrase) => !(phrase in spanish) || !(phrase in swedish));
    expect(missing).toEqual([]);
  });

  it('covers code-created control labels and shelf headings', () => {
    const files = [
      ...readdirSync(join(process.cwd(), 'src'), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.svelte'))
        .map((entry) => join(entry.parentPath, entry.name)),
      ...['atlasRows.ts', 'catalog.ts', 'services.ts', 'relatedRows.ts'].map((file) =>
        join(process.cwd(), 'src/lib', file),
      ),
    ];
    const found = new Set<string>();
    for (const filename of files) {
      const source = readFileSync(filename, 'utf8');
      for (const match of source.matchAll(
        /\b(?:(?:label|heading|title|detail|description|message|question|footer|empty|one):|(?:message|failure|notice|toast)\s*=)\s*'([^'\n]*[A-Za-z][^'\n]*)'/g,
      ))
        if (!INTERNAL_STATE.has(match[1])) found.add(match[1]);
    }
    const missing = [...found].filter((phrase) => !(phrase in spanish) || !(phrase in swedish));
    expect(missing).toEqual([]);
  });
});
