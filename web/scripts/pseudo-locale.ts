const ACCENTS: Readonly<Record<string, string>> = {
  a: 'à',
  A: 'À',
  e: 'ë',
  E: 'Ë',
  i: 'ï',
  I: 'Ï',
  o: 'ô',
  O: 'Ô',
  u: 'ü',
  U: 'Ü',
  y: 'ÿ',
  Y: 'Ÿ',
};

/** Development-only expansion locale: placeholders remain byte-for-byte so UI and catalog audits can exercise it. */
export function pseudoLocalize(message: string): string {
  const parts = message.split(/(\{[A-Za-z][A-Za-z0-9_]*\})/g);
  const transformed = parts
    .map((part) =>
      /^\{[A-Za-z][A-Za-z0-9_]*\}$/.test(part)
        ? part
        : [...part].map((character) => ACCENTS[character] ?? character).join(''),
    )
    .join('');
  const padding = ' ‼'.repeat(Math.max(1, Math.ceil(message.length / 20)));
  return `［${transformed}${padding}］`;
}
