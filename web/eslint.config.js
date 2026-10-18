import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

export default defineConfig(
  globalIgnores([
    'src/vendor/**',
    'dist/**',
    'dist-cast/**',
    'dist-shell/**',
    'dist-tv-*/**',
    'dist-browser-baseline/**',
    'tv-packages/**',
    'test-results/**',
    'test-results-tv/**',
    'playwright-report/**',
    'coverage/**',
    '.vite/**',
  ]),
  js.configs.recommended,
  ts.configs.recommended,
  svelte.configs.recommended,
  prettier,
  svelte.configs.prettier,
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/**', 'test/**', 'e2e/**'],
    languageOptions: {
      globals: {
        ...globals.browser,
        __DEN_TV__: 'readonly',
        __DEN_TV_PLATFORM__: 'readonly',
        __DEN_TV_PACKAGED__: 'readonly',
        __DEN_TV_API_ORIGIN__: 'readonly',
      },
    },
  },
  {
    files: ['public/sw.js'],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    files: [
      '*.{js,mjs,ts}',
      'scripts/**',
      'e2e/**',
      'src/**/*.test.ts',
      'test/sync-policy-browser.mjs',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parserOptions: { parser: ts.parser, extraFileExtensions: ['.svelte'], svelteConfig },
    },
  },
);
