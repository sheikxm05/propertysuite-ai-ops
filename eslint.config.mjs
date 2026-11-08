import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';
import prettier from 'eslint-config-prettier';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

/**
 * The two custom rules below are security boundaries, not style preferences.
 *
 *  1. The Supabase service-role client BYPASSES Row Level Security. It may only be
 *     imported from a server-only module. If it reaches a client component, the key
 *     ships to the browser and multi-tenant isolation is over.
 *  2. Environment variables are read once, Zod-validated, in lib/env.ts. Direct
 *     process.env access elsewhere defeats fail-fast validation and makes it easy to
 *     leak a server secret into a client bundle.
 */
const SERVICE_ROLE_PATTERNS = [
  {
    group: [
      '**/lib/supabase/service-role',
      '**/lib/supabase/service-role*',
      '@/lib/supabase/service-role*',
    ],
    message:
      'The service-role client bypasses RLS. Import it only from a server-only module (**/server-only/**) or a route handler. See CLAUDE.md rule 5.',
  },
  {
    group: ['**/server-only/**'],
    message:
      'server-only modules may only be imported by other server-side code. Never from a client component.',
  },
];

const config = [
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'next-env.d.ts',
      'supabase/**',
    ],
  },

  ...compat.extends('next/core-web-vitals', 'next/typescript'),

  {
    rules: {
      'no-restricted-imports': ['error', { patterns: SERVICE_ROLE_PATTERNS }],
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Read environment variables from lib/env.ts (Zod-validated, fail-fast). Direct process.env access is restricted — see CLAUDE.md.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='from'] > Literal[value=/^(organizations|profiles)$/]",
          message:
            'organizations and profiles are RLS-sensitive. Access them through lib/auth/roles.ts (resolveMembership), not ad hoc queries.',
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // Server-side code may import the service-role client and read process.env where the
  // env module itself cannot (bootstrapping, scripts, tooling, tests).
  {
    files: [
      '**/server-only/**',
      'lib/env.ts',
      'lib/supabase/**',
      'app/api/**',
      'services/**',
      'scripts/**',
      'tests/**',
      'evals/**',
      'instrumentation.ts',
      '*.config.{ts,mjs,js}',
    ],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
      'no-console': 'off',
    },
  },

  prettier,
];

export default config;
