import { defineConfig } from 'vitest/config';

// Only the server's tests: apps/ (the Mac console) has its own toolchain.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
