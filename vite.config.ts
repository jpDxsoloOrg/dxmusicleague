import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { ytmusicDevProxy } from './vite-plugin-ytmusic.js'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), ytmusicDevProxy()],
  // amazon-cognito-identity-js references a Node-style `global`; map it to the
  // browser global. (`Buffer` is polyfilled at runtime in src/polyfills.ts.)
  define: { global: 'globalThis' },
})
