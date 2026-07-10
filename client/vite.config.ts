import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  build: {
    target: 'esnext'
  },
  resolve: {
    // 默认把 .js 放在 .ts 前；IDE 若在 src 里生成同名幽灵 .js，会抢解析并在删除后 404
    extensions: ['.mjs', '.mts', '.ts', '.tsx', '.js', '.jsx', '.json'],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    proxy: {
      '/api': {
        // 显式使用 IPv4，避免 macOS/Linux 下 `localhost` 解析到 `::1` 导致连接拒绝
        target: 'http://127.0.0.1:3001',
        changeOrigin: true
      }
    }
  }
})
