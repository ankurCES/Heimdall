import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/process/index.ts')
      }
    },
    resolve: {
      alias: {
        '@common': resolve(__dirname, 'src/common'),
        '@process': resolve(__dirname, 'src/process')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts')
      }
    },
    resolve: {
      alias: {
        '@common': resolve(__dirname, 'src/common')
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html')
      }
    },
    resolve: {
      alias: {
        '@common': resolve(__dirname, 'src/common'),
        '@renderer': resolve(__dirname, 'src/renderer'),
        '@': resolve(__dirname, 'src/renderer')
      }
    },
    plugins: [react()]
  }
})
