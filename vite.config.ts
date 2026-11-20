import { defineConfig } from 'vite';
import { coverAlignPlugin } from './build/webwallgl-align.ts';

export default defineConfig({
  base: './',
  plugins: [coverAlignPlugin()],
  optimizeDeps: { exclude: ['webwallgl'] },
  server: {
    cors: { origin: '*' },
  },
  preview: {
    cors: { origin: '*' },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: 'index.html',
        sceneRenderer: 'scene-renderer.html',
      },
    },
  },
});
