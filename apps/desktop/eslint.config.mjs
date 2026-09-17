import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettierConfig from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-expressions': 'warn',
      'prefer-const': 'warn',
      'no-console': 'off',
      'no-empty': 'warn',
      'no-useless-escape': 'warn',
      'no-case-declarations': 'warn',
      'no-useless-assignment': 'warn',
      'no-undef': 'warn',
      'no-control-regex': 'warn',
      'no-sparse-arrays': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    ignores: [
      'node_modules/',
      '.next/',
      'dist/',
      'dist-electron/',
      'release/',
      'public/',
      'reference/',
      'src/lib/db/migrations/',
      'src/electron/',
      'scripts/',
      // Moved out of scripts/ (was scripts/eval); keeps its previous lint exemption.
      'evals/runner/',
      // Static export of the desktop renderer (BUILD_MODE=desktop next build).
      'out/',
    ],
  },
)
