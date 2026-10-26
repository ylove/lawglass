import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // CI runners (especially macOS) are slower than dev machines; keep real hangs visible.
    testTimeout: 15_000,
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'src/**/*.test.ts',
            'tests/**/*.test.ts',
            'scripts/**/*.test.ts',
            'scripts/**/*.test.mjs',
          ],
          exclude: [
            'src/web/**',
            'e2e/**',
            '**/*.live.test.ts',
            // Real-model tests need downloaded models (npm run models:fetch); opt in.
            ...(process.env.LOCAL_MODELS === '1'
              ? []
              : ['src/**/models.integration.test.ts']),
          ],
          setupFiles: ['tests/setup.node.ts'],
        },
      },
      {
        // Live tests call real services (Pinecone, LLM providers) and run only via
        // `npm run test:live` (nightly workflow), never in `npm run check`.
        test: {
          name: 'live',
          hookTimeout: 300_000,
          environment: 'node',
          include: ['src/**/*.live.test.ts', 'tests/**/*.live.test.ts'],
          testTimeout: 120_000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          environment: 'happy-dom',
          include: ['src/web/**/*.test.tsx'],
          setupFiles: ['tests/setup.web.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.d.ts'],
      reporter: ['text', 'html', 'json-summary'],
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 75,
        statements: 75,
        'src/core/index/local/**': {
          lines: 75,
          functions: 75,
          branches: 75,
          statements: 75,
        },
        'src/core/fetch/**': {
          lines: 90,
          functions: 90,
          branches: 85,
          statements: 90,
        },
        'src/core/history/{resolve,allowlist}.ts': {
          perFile: true,
          lines: 90,
          functions: 90,
          branches: 85,
          statements: 90,
        },
        'src/server/{session,gate,ingest-hosts,log}.ts': {
          perFile: true,
          lines: 90,
          functions: 90,
          branches: 85,
          statements: 90,
        },
        // The agent-facing surface: untrusted-text wrapping, fixed error text, and the queries
        // that decide what an agent sees.
        'src/mcp/{untrusted,errors,queries,shapes}.ts': {
          perFile: true,
          lines: 90,
          functions: 90,
          branches: 85,
          statements: 90,
        },
        'src/core/answer/citations*.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
          statements: 90,
        },
        'src/core/scenario/validate.ts': {
          lines: 90,
          branches: 90,
          statements: 90,
        },
      },
    },
  },
});
