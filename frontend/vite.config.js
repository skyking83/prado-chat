import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react()
  ],
  server: {
    host: true,
    port: 5173,
    watch: {
      usePolling: true,
    },
    proxy: {
      '/socket.io': {
        target: 'http://backend:3001',
        changeOrigin: true,
        secure: false,
        ws: true,
      },
      '/api': {
        target: 'http://backend:3001',
        changeOrigin: true,
        secure: false,
      },
      '/uploads': {
        target: 'http://backend:3001',
        changeOrigin: true,
        secure: false,
      }
    }
  }
})
