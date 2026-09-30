import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/infrastructure/persistence/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        { property: 'localStorage', message: 'Only the persistence adapter may use storage.' },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: 'Only the persistence adapter may use storage.' },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/infrastructure/overleaf/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/cm-line|role=.textbox|logs-pane|cm-content/]',
          message: 'Overleaf DOM structure is known only to infrastructure/overleaf.',
        },
        {
          selector: 'TemplateElement[value.raw=/cm-line|role=.textbox|logs-pane|cm-content/]',
          message: 'Overleaf DOM structure is known only to infrastructure/overleaf.',
        },
      ],
    },
  },
);
