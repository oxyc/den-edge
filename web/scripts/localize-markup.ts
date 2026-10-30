import { relative, sep } from 'node:path';
import { parse } from 'svelte/compiler';

const LOCALIZABLE_ATTRIBUTES = new Set([
  'alt',
  'aria-label',
  'ariaLabel',
  'cancelLabel',
  'caption',
  'confirmLabel',
  'description',
  'detail',
  'empty',
  'footer',
  'heading',
  'label',
  'message',
  'one',
  'placeholder',
  'question',
  'title',
]);
const VERBATIM_ELEMENTS = new Set(['code', 'kbd', 'pre', 'script', 'style']);

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

interface Node {
  readonly type?: string;
  readonly start?: number;
  readonly end?: number;
  readonly name?: string;
  readonly data?: string;
  readonly value?: unknown;
  readonly content?: { readonly start?: number };
  readonly [key: string]: unknown;
}

const phrase = (value: string): string => value.replace(/\s+/g, ' ').trim();
const hasWords = (value: string): boolean => /[A-Za-zÀ-ÿ]/.test(value);

function localizeOutputExpression(
  node: Node | undefined,
  edits: Edit[],
  phrases: Set<string>,
): void {
  if (!node || typeof node !== 'object') return;
  if (
    (node.type === 'Literal' || node.type === 'StringLiteral') &&
    typeof node.value === 'string' &&
    hasWords(node.value) &&
    typeof node.start === 'number' &&
    typeof node.end === 'number'
  ) {
    phrases.add(node.value);
    edits.push({
      start: node.start,
      end: node.end,
      value: `i18n.phrase(${JSON.stringify(node.value)})`,
    });
    return;
  }
  if (node.type === 'ConditionalExpression') {
    localizeOutputExpression(node.consequent as Node, edits, phrases);
    localizeOutputExpression(node.alternate as Node, edits, phrases);
  } else if (node.type === 'LogicalExpression') {
    localizeOutputExpression(node.right as Node, edits, phrases);
  }
}

function visit(
  node: Node | undefined,
  ancestors: readonly Node[],
  edits: Edit[],
  phrases: Set<string>,
): void {
  if (!node || typeof node !== 'object') return;
  if (
    node.type === 'Attribute' &&
    LOCALIZABLE_ATTRIBUTES.has(node.name ?? '') &&
    Array.isArray(node.value) &&
    node.value.length === 1
  ) {
    const text = node.value[0] as Node;
    const translated =
      text.type === 'Text' && typeof text.data === 'string' ? phrase(text.data) : '';
    if (
      translated &&
      hasWords(translated) &&
      typeof node.start === 'number' &&
      typeof node.end === 'number'
    ) {
      phrases.add(translated);
      edits.push({
        start: node.start,
        end: node.end,
        value: `${node.name}={i18n.phrase(${JSON.stringify(translated)})}`,
      });
      return;
    }
    const expression = node.value[0] as Node;
    if (expression.type === 'ExpressionTag') {
      localizeOutputExpression(expression.expression as Node, edits, phrases);
      if (edits.length) {
        // Continue walking only when this attribute did not provide any translatable output branches.
        const latest = edits.at(-1);
        if (latest && latest.start >= (node.start ?? Number.MAX_SAFE_INTEGER)) return;
      }
    }
  }
  if (node.type === 'ExpressionTag' && ancestors.at(-1)?.type !== 'Attribute')
    localizeOutputExpression(node.expression as Node, edits, phrases);
  if (node.type === 'Text' && typeof node.data === 'string') {
    const parent = ancestors.at(-1);
    const attribute = parent?.type === 'Attribute' ? parent.name : undefined;
    const verbatim = ancestors.some(
      (ancestor) =>
        ancestor.type === 'RegularElement' && VERBATIM_ELEMENTS.has(ancestor.name ?? ''),
    );
    const translated = phrase(node.data);
    if (
      !verbatim &&
      translated &&
      hasWords(translated) &&
      (!attribute || LOCALIZABLE_ATTRIBUTES.has(attribute)) &&
      typeof node.start === 'number' &&
      typeof node.end === 'number'
    ) {
      phrases.add(translated);
      const leading = node.data.match(/^\s*/)?.[0] ?? '';
      const trailing = node.data.match(/\s*$/)?.[0] ?? '';
      edits.push({
        start: node.start,
        end: node.end,
        value: `${leading}{i18n.phrase(${JSON.stringify(translated)})}${trailing}`,
      });
      return;
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'metadata' || key === 'parent') continue;
    if (Array.isArray(value))
      for (const child of value) visit(child as Node, [...ancestors, node], edits, phrases);
    else if (value && typeof value === 'object')
      visit(value as Node, [...ancestors, node], edits, phrases);
  }
}

function applyEdits(source: string, edits: readonly Edit[]): string {
  let output = source;
  for (const edit of [...edits].sort((left, right) => right.start - left.start))
    output = `${output.slice(0, edit.start)}${edit.value}${output.slice(edit.end)}`;
  return output;
}

/**
 * Compile static Svelte copy through the same lazy catalog as dynamic copy. This is a build-only transform: English
 * remains in its original component chunk and does not pay for a duplicate catalog or a runtime DOM scan.
 */
export const localizeMarkup = () => ({
  name: 'den-localize-markup',
  markup({ content, filename }: { content: string; filename?: string }) {
    if (!filename || !filename.includes(`${sep}src${sep}`)) return { code: content };
    const ast = parse(content, { modern: true }) as unknown as {
      readonly fragment: Node;
      readonly instance?: Node;
    };
    const edits: Edit[] = [];
    const phrases = new Set<string>();
    visit(ast.fragment, [], edits, phrases);
    if (!edits.length) return { code: content };

    if (
      !content.includes("from './lib/i18n.svelte'") &&
      !content.includes("from '../lib/i18n.svelte'")
    ) {
      let module = relative(
        filename.slice(0, filename.lastIndexOf(sep)),
        `${process.cwd()}/src/lib/i18n.svelte`,
      )
        .split(sep)
        .join('/');
      if (!module.startsWith('.')) module = `./${module}`;
      const statement = `\n  import { i18n } from ${JSON.stringify(module)};`;
      const start = ast.instance?.content?.start;
      if (typeof start === 'number') edits.push({ start, end: start, value: statement });
      else edits.push({ start: 0, end: 0, value: `<script>${statement}\n</script>\n` });
    }
    return { code: applyEdits(content, edits) };
  },
});
