import { defineConfig } from 'vitest/config';
import { transformWithOxc } from 'vite';
import path from 'path';

export default defineConfig({
  // Next.js app pages are .js files containing JSX (Next parses them fine,
  // vite does not by default). Transform src/**/*.js as JSX so tests can
  // render real pages (tolls-page.test.jsx was the first to need it).
  plugins: [
    {
      name: 'treat-app-js-as-jsx',
      enforce: 'pre',
      async transform(code, id) {
        if (!/[\\/]src[\\/].*\.js$/.test(id) || id.includes('node_modules')) return null;
        return transformWithOxc(code, id, { lang: 'jsx' });
      },
    },
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './test/setup.js',
    include: ['test/**/*.test.{js,jsx}'],
    exclude: ['src/**/*.test.mjs'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
