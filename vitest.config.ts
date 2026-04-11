import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@myerscarpenter/cast2-protocol': resolve(__dirname, 'packages/cast2-protocol/src/index.ts'),
    },
  },
});
