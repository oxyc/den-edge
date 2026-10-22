import postcss from 'postcss';
import postcssLogical from 'postcss-logical';
import { describe, expect, it } from 'vitest';
import {
  tizen3FixedViewportMath,
  tizen3ScrollLogical,
  tizen3UnsupportedEnhancements,
} from './tizen3-css-compat';

async function transform(css: string): Promise<string> {
  return (
    await postcss([
      tizen3UnsupportedEnhancements(),
      tizen3FixedViewportMath(),
      tizen3ScrollLogical(),
      postcssLogical({ blockDirection: 'top-to-bottom', inlineDirection: 'left-to-right' }),
    ]).process(css, { from: undefined })
  ).css;
}

describe('Tizen 3 CSS compatibility', () => {
  it('replaces responsive math only in the fixed-viewport compatibility output', async () => {
    const css = await transform(`
      .player {
        padding: clamp(24px, 3.2vh, 42px) 5vw clamp(70px, 9vh, 110px);
        right: max(96px, calc((100vw - 1400px) / 2 + 96px));
      }
    `);

    expect(css).toContain('padding: 34.56px 96px 97.2px;');
    expect(css).not.toContain('clamp(');
    expect(css).toContain('right: 356px;');
    expect(css).not.toContain('right: max(');
  });

  it('uses zero TV safe areas and leaves context-dependent expressions for the audit', async () => {
    const css = await transform(`
      .dialog {
        top: max(12px, env(safe-area-inset-top));
        width: min(100%, 360px);
        max-width: min(72vw, 64ch);
        height: var(--runtime, clamp(20px, 10vh, 200px));
      }
    `);

    expect(css).toContain('top: 12px;');
    expect(css.match(/\n\s*width:/g)).toHaveLength(1);
    expect(css.match(/\n\s*max-width:/g)).toHaveLength(1);
    expect(css.match(/\n\s*height:/g)).toHaveLength(1);
  });

  it('lowers logical geometry for Den’s fixed left-to-right TV shell', async () => {
    const css = await transform(`
      .row {
        padding-inline: 20px 40px;
        scroll-padding-inline: 12px 0;
        scroll-margin-block: 140px 16px;
      }
    `);

    expect(css).toContain('padding-left: 20px;');
    expect(css).toContain('padding-right: 40px;');
    expect(css).toContain('scroll-padding-left: 12px;');
    expect(css).toContain('scroll-padding-right: 0;');
    expect(css).toContain('scroll-margin-top: 140px;');
    expect(css).toContain('scroll-margin-bottom: 16px;');
    expect(css).not.toMatch(/(?:padding|margin)-inline|margin-block/);
  });

  it('removes enhancement branches which Chromium 47 can never enter', async () => {
    const css = await transform(`
      .surface { color: #c8d3ef; }
      @supports (color: color-mix(in srgb, white, black)) {
        .surface { color: color-mix(in srgb, var(--fg) 78%, var(--accent)); }
      }
    `);

    expect(css).toContain('color: #c8d3ef;');
    expect(css).not.toContain('color-mix');
    expect(css).not.toContain('@supports');
  });
});
