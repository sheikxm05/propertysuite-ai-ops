/**
 * Vitest configuration — lane w0-l6.
 *
 * Two suites live in this repository and they have very different requirements:
 *
 *   unit        packages/shared (w0-l4), lib (w0-l5), the feature lanes' tests/<domain>
 *               directories, and this lane's harness self-tests. No external services.
 *   gated       tests/rls needs a real Postgres with RLS active; evals needs an AI
 *               provider key. Neither can run on a bare `npm ci`.
 *
 * `npm test` (plain `vitest run`) must stay green on a machine with no Docker and no
 * API key, or CI's unit job fails for reasons that have nothing to do with the code.
 * So a gated suite is discovered only when it is explicitly asked for — by naming it on
 * the command line (`vitest run tests/rls`, which is what `npm run test:rls` does) or by
 * setting PS_RLS=1 / PS_EVALS=1.
 *
 * The alternative — skipping gated tests silently when their service is absent — was
 * rejected. A hard gate that quietly reports success is worse than no gate: this lane's
 * whole purpose is that an unproven isolation claim must be visible.
 */

import { defineConfig, type UserConfig } from 'vitest/config';

/** Positional CLI arguments, i.e. Vitest's own file filters. */
const filters = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith('-'))
  .filter((arg) => !['run', 'watch', 'dev', 'bench', 'related', 'list', 'init'].includes(arg))
  .map((arg) => arg.replace(/\\/g, '/'));

const asked = (needle: string) => filters.some((f) => f.includes(needle));

const rlsRequested = asked('tests/rls') || process.env.PS_RLS === '1';
const evalsRequested = asked('evals') || process.env.PS_EVALS === '1';

const gatedExclusions = [
  ...(rlsRequested ? [] : ['tests/rls/**']),
  ...(evalsRequested ? [] : ['evals/**']),
];

/**
 * The config is async and imports its plugins dynamically on purpose.
 * `vite-tsconfig-paths@5` and `@vitejs/plugin-react@4` are both ESM-only, and this
 * package has no `"type": "module"` (package.json belongs to lane w0-l1 and is not
 * ours to change), so Vite bundles this file as CJS and a static import of either one
 * fails with "ESM file cannot be loaded by require". A dynamic import inside an async
 * factory is evaluated as ESM and works. Do not "simplify" this back to static imports.
 */
export default defineConfig(async (): Promise<UserConfig> => {
  const [{ default: tsconfigPaths }, { default: react }] = await Promise.all([
    import('vite-tsconfig-paths'),
    import('@vitejs/plugin-react'),
  ]);

  return {
    plugins: [
      // `@/*` and `@shared/*` come from tsconfig.json, so a test imports exactly what the
      // application imports. No second copy of the alias map to drift out of sync.
      tsconfigPaths(),
      react(),
    ],

    test: {
      environment: 'node',
      globals: true,
      setupFiles: ['tests/_harness/setup.ts'],
      include: [
        'packages/shared/**/*.{test,spec}.{ts,tsx}',
        'lib/**/*.{test,spec}.{ts,tsx}',
        'lib/**/__tests__/**/*.{test,spec}.{ts,tsx}',
        'services/**/*.{test,spec}.{ts,tsx}',
        'tests/**/*.{test,spec}.{ts,tsx}',
        'evals/**/*.{test,spec}.{ts,tsx}',
      ],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '.next/**',
        // Playwright owns tests/e2e (w2-l1). Vitest must never pick those up.
        'tests/e2e/**',
        'tests/_harness/e2e/**',
        ...gatedExclusions,
      ],

      // The RLS suite shares one database and one fixture set. Running its files in
      // parallel workers would make assertions race each other and produce flaky
      // "isolation proven" results, which is the one outcome this lane cannot ship.
      pool: 'forks',
      poolOptions: { forks: { singleFork: rlsRequested } },
      fileParallelism: !rlsRequested,
      sequence: { concurrent: false },

      // Seeding two organizations through real HTTP calls is slow; assertions are not.
      testTimeout: rlsRequested ? 60_000 : 10_000,
      hookTimeout: rlsRequested ? 180_000 : 20_000,

      // Resolves credentials, verifies the stack is reachable, seeds the fixtures, and on
      // teardown writes the policy-coverage report and fails the run if any policy in the
      // §4 matrix was never exercised.
      globalSetup: rlsRequested ? ['tests/_harness/rls-global-setup.ts'] : [],

      reporters: process.env.CI ? ['default', 'junit'] : ['default'],
      outputFile: { junit: 'test-results/vitest-junit.xml' },

      coverage: {
        provider: 'v8',
        reportsDirectory: 'coverage',
        reporter: ['text', 'html', 'lcov'],
        include: ['lib/**', 'packages/shared/**', 'services/**'],
        exclude: ['**/*.test.ts', '**/__tests__/**', '**/types/**', '**/*.d.ts'],
      },
    },
  };
});
