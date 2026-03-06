import eslint from '@eslint/js'
import globals from 'globals'
import parser from '@typescript-eslint/parser'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['release-*', 'lib', 'public', 'build', 'json-data', '.turbo'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    languageOptions: {
      globals: globals.node,
      parser,
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      'no-console': 2,
      'no-use-before-define': 2,
      'require-await': 2,
      '@typescript-eslint/consistent-type-imports': 2,
      '@typescript-eslint/no-explicit-any': 0,
      '@typescript-eslint/no-floating-promises': 2,
      '@typescript-eslint/no-unused-vars': 0,
    },
  },
  {
    files: ['homebridge-ui/**/*.ts'],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      'no-use-before-define': 'off',
    },
  },
)
