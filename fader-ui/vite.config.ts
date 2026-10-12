import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // доступно с других устройств в локальной сети (телефон/планшет)
    port: 5173,
  },
})
