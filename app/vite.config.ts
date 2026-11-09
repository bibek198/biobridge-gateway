import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { synthApi } from './vite-plugin-synth.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), synthApi()],
})
