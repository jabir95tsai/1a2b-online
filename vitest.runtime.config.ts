import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    remoteBindings: false,
    miniflare: { bindings: { AUTH_SECRET: 'a'.repeat(64) } },
  })],
  test: {
    include: ['tests/runtime/**/*.test.ts'],
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
