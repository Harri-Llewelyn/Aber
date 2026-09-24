/**
 * The ESLint configuration, as a function of the plugins so scripts/lint-js.mjs can load them from
 * its pinned install under .cache/ rather than from a node_modules this repository does not have.
 *
 * The rules are the ones that catch bugs: eslint:recommended, React's, and the two classic hooks
 * rules. Not enabled, deliberately: React Compiler's hooks rules (this app does not use the
 * compiler) and react/no-unescaped-entities (an apostrophe in JSX text renders correctly). The
 * explicit `import React` the codebase writes is accepted though the JSX runtime does not need it.
 */
export default function config ({ js, react, hooks, globals }) {
  const unused = ['error', { varsIgnorePattern: '^React$', argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }]
  return [
    { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '.cache/**', '**/*.generated.*'] },
    { linterOptions: { reportUnusedDisableDirectives: 'error' } },
    js.configs.recommended,
    {
      files: ['frontend/**/*.{js,jsx}'],
      plugins: { react, 'react-hooks': hooks },
      languageOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } },
        globals: { ...globals.browser, ...globals.node, ...globals.vitest },
      },
      settings: { react: { version: 'detect' } },
      rules: {
        ...react.configs.recommended.rules,
        ...react.configs['jsx-runtime'].rules,
        'react/prop-types': 'off',
        'react/no-unescaped-entities': 'off',
        'react-hooks/rules-of-hooks': 'error',
        'react-hooks/exhaustive-deps': 'warn',
        'no-new-func': 'error',
        'no-unused-vars': unused,
      },
    },
    {
      files: ['scripts/**/*.mjs', 'forge/**/*.mjs', 'supabase/**/*.mjs'],
      languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
      rules: { 'no-unused-vars': unused },
    },
  ]
}
