import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const browserGlobals = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'fetch',
  'XMLHttpRequest',
  'HTMLElement',
  'Element',
  'Node',
  'Range',
  'Selection',
  'MutationObserver',
  'requestAnimationFrame',
  'setTimeout',
  'setInterval',
];

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'ola-helper.js', 'overleaf-ai-assistant.js'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.browser },
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
    files: ['src/domain/**/*.ts', 'src/application/**/*.ts', 'src/ports/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...browserGlobals.map((name) => ({
          name,
          message: 'Browser/runtime APIs belong to infrastructure or presentation.',
        })),
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
