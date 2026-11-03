// eslint.config.cjs
//
// ESLint flat configuration adapted from gts 7.0.0.
//
// Workaround: gts 7.0.0's published package ships its repo-root
// eslint.config.js (listed in package.json "files") but not the src/ tree it
// requires, so loading that file dies with MODULE_NOT_FOUND on
// require('./src/index.js'). The compiled build/eslint.config.js works because
// tsc's rootDir/outDir preserves the relative path into build/src. Requiring
// 'gts' routes through package.json "main" (build/src/index.js) and yields the
// same eight flat-config blocks (Prettier layer, base rules, and
// typescript-eslint recommended config) that the README's
// `[...require('gts')]` pattern prescribes.
//
// Notes:
// - package.json defines "type": "module", so config files use CommonJS (.cjs).
// - gts and eslint run under Node, while project scripts/tests run under Bun.

const gts = require('gts');
const globals = require('globals');
const tseslint = require('typescript-eslint');

const OVERRIDES = {
  // Allow underscore prefix for required callback/interface parameters that are unused.
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    },
  ],
  // Permit `== null` / `!= null` shorthand to test for both null and undefined.
  eqeqeq: ['error', 'always', {null: 'ignore'}],
  // BufferingTransport.publish implements GoalTuiPublishFn synchronously, but the
  // interface type union includes Promise<void>, triggering false-positive floating promise errors.
  '@typescript-eslint/no-floating-promises': 'off',
  // Allow control flow statements in `finally` in child-session-verifier.ts
  // to ensure fail-closed behavior when operational failures must override verdicts.
  'no-unsafe-finally': 'off',
  // Handled by TypeScript for .ts/.tsx files; re-enabled specifically for CommonJS files below.
  'no-undef': 'off',
};

module.exports = [
  // gts presets: Prettier integration, base lint rules, and typescript-eslint recommended.
  ...gts,
  // ESLint flat config requires the plugin definition in the same config object referencing its rules.
  // Re-register typescript-eslint base config so subsequent override blocks can use @typescript-eslint rules.
  ...[tseslint.configs.base],
  {
    name: 'fixate-on/overrides',
    files: ['**/*.ts', '**/*.tsx', '**/*.mjs', '**/*.js', '**/*.cjs'],
    rules: OVERRIDES,
  },
  {
    // Re-enable no-undef for CommonJS files to validate globals (require, module, __dirname).
    name: 'fixate-on/commonjs',
    files: ['*.cjs', '**/.prettierrc.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {'no-undef': 'error'},
  },
  {
    name: 'fixate-on/ignores',
    // Mirrors .gitignore: `gts lint` invokes eslint without file paths, causing it to walk
    // the working directory. Explicit ignores prevent linting untracked/third-party artifacts.
    ignores: [
      'node_modules/**',
      // Build output / generated bundle.
      'plugin/**',
      'examples/**',
      // Local tooling and scratch directories (mirrors .gitignore).
      '.agents/**',
      '.claude/**',
      '.idea/**',
      '.omo/**',
      '.osm/**',
      '.playwright-mcp/**',
      'scratch/**',
      // E2E harness runtime artifacts, isolated HOME/XDG trees, and test fixtures.
      'hack/e2e-harness/**',
    ],
  },
];
