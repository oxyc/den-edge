export default {
  extends: ['stylelint-config-standard', 'stylelint-config-html/svelte'],
  ignoreFiles: [
    'src/vendor/**',
    'dist/**',
    'node_modules/**',
    'test-results/**',
    'playwright-report/**',
  ],
  reportDescriptionlessDisables: true,
  reportInvalidScopeDisables: true,
  reportNeedlessDisables: true,
  rules: {
    'alpha-value-notation': 'number',
    // Retain explicit WebKit fallbacks: iPhone browsers share Safari's engine.
    'property-no-vendor-prefix': [
      true,
      {
        ignoreProperties: [
          '-webkit-backdrop-filter',
          '-webkit-user-select',
          '-webkit-line-clamp',
          '-webkit-box-orient',
        ],
      },
    ],
    'selector-pseudo-class-no-unknown': [true, { ignorePseudoClasses: ['global'] }],
    'keyframes-name-pattern': '^(-global-)?[a-z][a-z0-9]*(-[a-z0-9]+)*$',
  },
};
