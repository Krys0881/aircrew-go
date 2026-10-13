import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// Reuse the Mac app's renderer components straight from the Aircrew repo (no copies):
// import { MessageMarkdown } from '@aircrew/components/MessageMarkdown'
const aircrewRenderer = fileURLToPath(new URL('../ai-gram/src/renderer', import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@aircrew': aircrewRenderer,
    },
    // the aliased files live outside this project: resolve their deps from OUR node_modules
    dedupe: ['react', 'react-dom', 'react-markdown', 'mermaid', 'shiki', 'katex'],
  },
  server: { fs: { allow: ['..'] } },
})
