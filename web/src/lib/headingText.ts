import type { InterfaceLanguage } from './interfaceLanguage';

/** Sentence-case a translated section heading without changing the catalog copy used in prose or controls. */
export function capitalizeHeading(value: string, language: InterfaceLanguage): string {
  if (!value) return value;
  const first = value.charAt(0);
  return first.toLocaleUpperCase(language) + value.slice(first.length);
}
