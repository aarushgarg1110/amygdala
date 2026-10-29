import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'reports/'] },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    // A rule can only be turned off here, where review sees it, never by an inline comment.
    linterOptions: { noInlineConfig: true },
    rules: {
      // A promise nobody awaits is a request that was dropped or never scanned.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'default', format: ['camelCase'] },
        {
          selector: 'variable',
          modifiers: ['global', 'const'],
          types: ['boolean', 'number', 'string', 'array'],
          format: ['UPPER_CASE'],
        },
        { selector: 'variable', format: ['camelCase', 'UPPER_CASE'] },
        { selector: 'typeLike', format: ['PascalCase'] },
        {
          selector: 'memberLike',
          modifiers: ['private'],
          format: ['camelCase'],
          leadingUnderscore: 'require',
        },
        // Wire formats (JSON keys such as content_block_delta) keep their own names.
        { selector: ['objectLiteralProperty', 'typeProperty'], format: null },
        { selector: 'import', format: null },
      ],
    },
  },
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
);
