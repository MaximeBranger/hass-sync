import js from '@eslint/js'
import globals from 'globals'

export default [
  js.configs.recommended,
  {
    // shared/es6-promise.js is a vendored third-party polyfill, not our code to lint.
    ignores: ['dist/**', 'node_modules/**', 'shared/es6-promise.js'],
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.node },
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        // Ambient globals injected by the Zepp OS build tool depending on file context
        // (device app, app-service, app-side, settings page).
        App: 'readonly',
        Page: 'readonly',
        getApp: 'readonly',
        AppService: 'readonly',
        AppSideService: 'readonly',
        AppSettingsPage: 'readonly',
        Logger: 'readonly',
        settings: 'readonly',
        messaging: 'readonly',
        DEBUG: 'readonly',
        View: 'readonly',
        Section: 'readonly',
        TextInput: 'readonly',
        Slider: 'readonly',
        Text: 'readonly',
        Toggle: 'readonly',
      },
    },
  },
  {
    files: ['shared/device-polyfill.js'],
    languageOptions: {
      globals: {
        ES6Promise: 'readonly',
      },
    },
  },
  {
    files: ['test/**/*.js', 'vitest.config.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
    },
  },
]
