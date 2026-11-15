import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Fetch scripts run in a utility process of their own, see src/main/conferences/scripts.ts
          runner: resolve(__dirname, 'src/main/conferences/runner.ts'),
          // Paper search, with its model, in a utility process of its own, see src/main/conferences/finding.ts
          finder: resolve(__dirname, 'src/main/conferences/finder.ts')
        }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          pet: resolve(__dirname, 'src/preload/pet.ts'),
          call: resolve(__dirname, 'src/preload/call.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          worker: resolve(__dirname, 'src/renderer/worker.html'),
          call: resolve(__dirname, 'src/renderer/call.html')
        }
      }
    }
  }
})
