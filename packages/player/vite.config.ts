import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      // The IIFE global must not be DreambyteStudioPlayer: src/index.ts assigns the
      // class to window.DreambyteStudioPlayer, and the lib wrapper would overwrite it
      // with the module namespace.
      name: 'DreambytePlayer',
      fileName: 'dreambyte-player',
      formats: ['iife', 'es'],
    },
    outDir: 'dist',
    minify: true,
    rollupOptions: {
      output: {
        exports: 'named',
      },
    },
  },
})
