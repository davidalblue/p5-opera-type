import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    // p5 is ~1 MB minified on its own
    chunkSizeWarningLimit: 1500,
  },
})
