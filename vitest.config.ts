import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
          exclude: ['src/web/**'],
          setupFiles: ['tests/setup.node.ts'],
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
        'src/core/fetch/**': {
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
      },
    },
  },
});
