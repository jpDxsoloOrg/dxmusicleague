import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { ytmusicDevProxy } from './vite-plugin-ytmusic.js'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), ytmusicDevProxy()],
})
