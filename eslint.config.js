// Lint for the server (src/, scripts/, eval/, test/) and the browser pages (public/*.js, plain scripts).
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'recordings/', '.data/', 'kb/corpus/raw/', 'modal/'] },
  js.configs.recommended,
  {
    files: ['src/**/*.{js,mjs}', 'scripts/**/*.{js,mjs}', 'eval/**/*.{js,mjs}', 'test/**/*.js', '*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
      // The sanitisers strip control characters on purpose.
      'no-control-regex': 'off',
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.browser, Overlay: 'readonly' } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // Puppeteer callbacks run in the page.
    files: ['scripts/sim/e2e.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['public/pcm-worklet.js'],
    languageOptions: { globals: { ...globals.audioWorklet } },
  },
];
