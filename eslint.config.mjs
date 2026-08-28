import unusedImports from 'eslint-plugin-unused-imports'
import { configs } from 'typescript-eslint'
import { defineConfig, includeIgnoreFile } from 'eslint/config'
import { importX } from 'eslint-plugin-import-x'
import eslintConfigPrettier from 'eslint-config-prettier/flat'
import { fileURLToPath } from 'node:url'

const gitignorePath = fileURLToPath(new URL('.gitignore', import.meta.url))

export default defineConfig([
  includeIgnoreFile(gitignorePath, { gitignoreResolution: true }),
  ...configs.recommended,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  eslintConfigPrettier,
  {
    ignores: [
      '.claude/**',
      '**/dist/**',
      '**/.next/**',
      '**/*.config.{ts,js,cjs,mjs}',
      'packages/web/next-env.d.ts',
      'packages/control-plane/prisma/migrations/**'
    ]
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module'
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      'unused-imports': unusedImports
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module'
    },
    rules: {
      '@typescript-eslint/no-inferrable-types': ['off'],
      '@typescript-eslint/no-empty-function': ['off'],
      '@typescript-eslint/no-unused-vars': ['off'],
      '@typescript-eslint/no-this-alias': ['off'],
      '@typescript-eslint/no-explicit-any': ['off'],
      '@typescript-eslint/no-unused-expressions': ['warn'],
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': 'allow-with-description',
          'ts-expect-error': 'allow-with-description'
        }
      ],
      'import-x/no-named-as-default': ['off'],
      'import-x/no-named-as-default-member': ['off'],
      'import-x/no-unresolved': ['off'],
      'unused-imports/no-unused-imports': 'error'
    }
  },
  {
    // Tenancy fence (docs/designs/org-scoped-data-layer.md §6): the HTTP
    // surface resolves resources through org-fenced repo methods only; the
    // `*Unscoped` escape hatches belong to internal trust domains. A
    // public-by-design endpoint may disable this inline with a justification.
    files: ['packages/control-plane/src/http/routes/**/*.ts', 'packages/control-plane/src/http/mcp/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.property.name=/Unscoped$/]',
          message:
            'Tenancy-unscoped reads are forbidden on the HTTP surface — use the org-fenced method with the request org (docs/designs/org-scoped-data-layer.md §6).'
        }
      ]
    }
  },
  {
    // Same fence on the daemon WS surface (k8s-daemon-pool.md M4): an install-wide
    // member carries many orgs on one socket, so a handler resolves resources with
    // the frame's org (`frame.orgId`) or the connection's (`conn.orgId`) — never by
    // reading a row unscoped and trusting the org it happens to carry. An
    // install-wide read may disable this inline with a justification.
    files: ['packages/control-plane/src/ws/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.property.name=/Unscoped$/]',
          message:
            'Tenancy-unscoped reads are forbidden on the daemon WS surface — use the org-fenced method with the frame or connection org (docs/designs/org-scoped-data-layer.md §6).'
        }
      ]
    }
  },
  {
    // `@iconify-icons/*` v2 points every icon subpath at one shared `data.d.ts`, so importing two
    // icons from one pack resolves to the same file and reads as a duplicate import.
    files: ['packages/web/src/components/marks.tsx'],
    rules: {
      'import-x/no-duplicates': ['off']
    }
  }
])
