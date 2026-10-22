import { calc } from '@csstools/css-calc';
import { list, type Declaration, type Plugin } from 'postcss';

const VIEWPORT_WIDTH = 1920;
const VIEWPORT_HEIGHT = 1080;
const ROOT_FONT_SIZE = 16;
const CSS_MATH = /\b(?:clamp|min|max)\(/;
const UNSUPPORTED_RESULT = /\b(?:clamp|min|max)\(|var\(|env\(/;
const FIXED_UNIT = /(-?(?:\d+\.?\d*|\.\d+))(dvw|svw|lvw|vw|dvh|svh|lvh|vh|vmin|vmax|rem)\b/gi;
const SAFE_AREA = /env\(safe-area-inset-(?:top|right|bottom|left)(?:\s*,[^)]*)?\)/gi;
const SCROLL_LOGICAL = /^scroll-(padding|margin)-(inline|block)$/;
const FOCUS_HAS = /:has\([^)]*:focus(?:-visible)?[^)]*\)/g;

function pixels(value: number, unit: string): number {
  switch (unit.toLowerCase()) {
    case 'dvw':
    case 'svw':
    case 'lvw':
    case 'vw':
      return (value * VIEWPORT_WIDTH) / 100;
    case 'dvh':
    case 'svh':
    case 'lvh':
    case 'vh':
      return (value * VIEWPORT_HEIGHT) / 100;
    case 'vmin':
      return (value * Math.min(VIEWPORT_WIDTH, VIEWPORT_HEIGHT)) / 100;
    case 'vmax':
      return (value * Math.max(VIEWPORT_WIDTH, VIEWPORT_HEIGHT)) / 100;
    case 'rem':
      return value * ROOT_FONT_SIZE;
    default:
      return Number.NaN;
  }
}

function fixedViewportValue(value: string): string | undefined {
  const fixed = value
    .replace(SAFE_AREA, '0px')
    .replace(FIXED_UNIT, (_match, amount: string, unit: string) => {
      const result = pixels(Number(amount), unit);
      return Number.isFinite(result) ? `${result}px` : _match;
    });
  try {
    const resolved = calc(fixed, { precision: 5 });
    if (resolved === value || UNSUPPORTED_RESULT.test(resolved)) return undefined;
    return resolved;
  } catch {
    return undefined;
  }
}

/**
 * Tizen 3 exposes a fixed 1920x1080 CSS viewport but predates CSS math functions. Replace each resolvable value in
 * this isolated build; authored source and every modern build retain the responsive declaration. Ambiguous
 * percentages, font-relative `ch` values and runtime variables deliberately remain in the audit.
 */
export function tizen3FixedViewportMath(): Plugin {
  return {
    postcssPlugin: 'den:tizen3-fixed-viewport-math',
    Declaration(declaration: Declaration) {
      if (declaration.prop.startsWith('--') || !CSS_MATH.test(declaration.value)) return;
      const fallback = fixedViewportValue(declaration.value);
      if (!fallback) return;
      declaration.value = fallback;
    },
  };
}

/** Remove progressive enhancement branches which this exact target cannot enter. */
export function tizen3UnsupportedEnhancements(): Plugin {
  return {
    postcssPlugin: 'den:tizen3-unsupported-enhancements',
    AtRule(atRule) {
      if (atRule.name.toLowerCase() === 'supports' && /\bcolor-mix\(/i.test(atRule.params))
        atRule.remove();
    },
  };
}

/** postcss-logical covers box geometry but intentionally leaves the scroll snap logical shorthands alone. */
export function tizen3ScrollLogical(): Plugin {
  return {
    postcssPlugin: 'den:tizen3-scroll-logical',
    Declaration(declaration: Declaration) {
      const match = SCROLL_LOGICAL.exec(declaration.prop);
      if (!match) return;
      const values = list.space(declaration.value);
      if (values.length < 1 || values.length > 2) return;
      const [start, end = start] = values;
      const edges = match[2] === 'inline' ? ['left', 'right'] : ['top', 'bottom'];
      declaration.cloneBefore({ prop: `scroll-${match[1]}-${edges[0]}`, value: start });
      declaration.cloneBefore({ prop: `scroll-${match[1]}-${edges[1]}`, value: end });
      declaration.remove();
    },
  };
}

/**
 * A TV remote is a keyboard-like input, so its focus must always remain visible. Chromium 47 predates both modern
 * focus selectors. The shared capability listener already marks focus ancestors; lower the selectors only in the
 * exact Tizen 3 artifact instead of adding listeners to individual components.
 */
export function tizen3FocusSelectors(): Plugin {
  return {
    postcssPlugin: 'den:tizen3-focus-selectors',
    Rule(rule) {
      rule.selector = rule.selector
        .replace(FOCUS_HAS, '.tv-focus-within')
        .replace(/:focus-within\b/g, '.tv-focus-within')
        .replace(/:focus-visible\b/g, ':focus');
    },
  };
}

export const tizen3Viewport = {
  width: VIEWPORT_WIDTH,
  height: VIEWPORT_HEIGHT,
  rootFontSize: ROOT_FONT_SIZE,
};
