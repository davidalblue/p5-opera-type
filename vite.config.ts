import { defineConfig } from 'vite'

export default defineConfig({
  // served from https://davidalblue.github.io/p5-opera-type/
  base: '/p5-opera-type/',
  build: {
    // p5 is ~1 MB minified on its own
    chunkSizeWarningLimit: 1500,
  },
})
