import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Vitest config — mirrors the path aliases used by electron-vite so that
// service-layer tests can import @common/* the same way the runtime does.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  },
  resolve: {
    alias: {
      '@common': resolve(__dirname, 'src/common'),
      '@process': resolve(__dirname, 'src/process'),
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@preload': resolve(__dirname, 'src/preload')
    }
  }
})
