import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
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
