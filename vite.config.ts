import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const DEFAULT_API_PORT = 3311
const configuredPort = (value: string | undefined, fallback = DEFAULT_API_PORT) => {
  const port = Number(value ?? fallback)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback
}
const apiPort = configuredPort(process.env.PORT)
const apiTarget = `http://127.0.0.1:${apiPort}`

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': apiTarget,
      '/workspace-artifacts': apiTarget,
    },
  },
})
