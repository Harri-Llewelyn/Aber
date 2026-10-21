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
  // A `title` on an HTML element is the browser's tooltip, which a keyboard and a touch screen never
  // show. A component's `title` prop (Modal's heading, SortHeader's tooltip) is not one, so only a
  // lowercase element is matched. `abbr` and `iframe` keep `title`: it is what the element means.
  const browserTooltip = ['error', {
    selector: 'JSXOpeningElement[name.name=/^[a-z]/]:not([name.name=/^(abbr|iframe)$/]) > JSXAttribute[name.name="title"]',
    message: "A title is the browser's tooltip, never shown to a keyboard. Drop it, wrap the control in <Tooltip> (common/Tooltip.jsx), or give the column header the hint: frontend/README.md, Tooltips.",
  }]
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
        'no-restricted-syntax': browserTooltip,
      },
    },
    {
      // Still carrying a browser tooltip. Rewritten by other work now, so swept once that lands: the
      // Site Map and area plans, Backups and Cold Storage, Cells, the 3D model, the search, the drawer.
      files: [
        'frontend/src/components/tabs/SiteMapTab.jsx',
        'frontend/src/components/common/AreaPlan.jsx',
        'frontend/src/components/common/AreaPlanPanel.jsx',
        'frontend/src/components/tabs/BackupsTab.jsx',
        'frontend/src/components/tabs/ColdStorageTab.jsx',
        'frontend/src/components/tabs/CellsTab.jsx',
        'frontend/src/components/common/Model3DUploader.jsx',
        'frontend/src/components/common/GlobalSearch.jsx',
        'frontend/src/components/common/ContextPanel.jsx',
      ],
      rules: { 'no-restricted-syntax': 'off' },
    },
    {
      // Not yet swept.
      files: [
        'frontend/src/App.jsx',
        'frontend/src/components/auth/AuthShell.jsx',
        'frontend/src/components/common/AlertPill.jsx',
        'frontend/src/components/common/CellPlacementPicker.jsx',
        'frontend/src/components/common/ExpandAllToggle.jsx',
        'frontend/src/components/common/GatewayRepositoryPanel.jsx',
        'frontend/src/components/common/HoldToReveal.jsx',
        'frontend/src/components/common/Modal.jsx',
        'frontend/src/components/common/NotificationHistory.jsx',
        'frontend/src/components/common/QuarantinePayloadCell.jsx',
        'frontend/src/components/common/SegmentedControl.jsx',
        'frontend/src/components/common/SemanticIdField.jsx',
        'frontend/src/components/common/VocabularyPanel.jsx',
        'frontend/src/components/modals/ApproveQuarantineModal.jsx',
        'frontend/src/components/modals/ArchiveModal.jsx',
        'frontend/src/components/modals/AssetConfigModal.jsx',
        'frontend/src/components/modals/BugReportModal.jsx',
        'frontend/src/components/modals/DeprecateMetricModal.jsx',
        'frontend/src/components/modals/DeviceNameplateModal.jsx',
        'frontend/src/components/modals/EdgeNodeSettings.jsx',
        'frontend/src/components/modals/EntityLinksModal.jsx',
        'frontend/src/components/modals/GatewayBundleModal.jsx',
        'frontend/src/components/modals/GatewayCredentialModal.jsx',
        'frontend/src/components/modals/PasswordShownOnce.jsx',
        'frontend/src/components/modals/SchemaBuilderModal.jsx',
        'frontend/src/components/modals/SchemaDetailModal.jsx',
        'frontend/src/components/modals/SchemaForkModal.jsx',
        'frontend/src/components/modals/ServiceTokenModal.jsx',
        'frontend/src/components/modals/ShowGatewayCredentialModal.jsx',
        'frontend/src/components/modals/TelemetryExportModal.jsx',
        'frontend/src/components/modals/TelemetryModal.jsx',
        'frontend/src/components/modals/ValidatePayloadModal.jsx',
        'frontend/src/components/tabs/ApprovalsTab.jsx',
        'frontend/src/components/tabs/ProfileTab.jsx',
        'frontend/src/components/tabs/SchemasTab.jsx',
        'frontend/src/components/tabs/SettingsTab.jsx',
      ],
      rules: { 'no-restricted-syntax': 'off' },
    },
    {
      files: ['scripts/**/*.mjs', 'forge/**/*.mjs', 'supabase/**/*.mjs', 'test-harness/**/*.mjs'],
      languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
      rules: { 'no-unused-vars': unused },
    },
  ]
}
