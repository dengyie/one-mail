import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { NaiveUiResolver } from 'unplugin-vue-components/resolvers'
import wasm from "vite-plugin-wasm";

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    outDir: './dist',
  },
  // 本地 dev 直连本地 Worker（wrangler dev 默认 8787）。前后端分离：生产走 VITE_API_BASE 跨域直连，
  // dev 这里用同源 proxy 避免 CORS 干扰本地联调。wrangler dev 请用 `--local` 以复用本地 D1/KV。
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/open_api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/user_api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/admin': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/telegram': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/external': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
  plugins: [
    vue(),
    wasm(),
    AutoImport({
      imports: [
        'vue',
        {
          'naive-ui': [
            'useMessage',
            'useNotification',
            'NButton',
            'NPopconfirm',
            'NIcon',
          ]
        }
      ]
    }),
    Components({
      resolvers: [NaiveUiResolver()]
    }),
    VitePWA({
      registerType: null,
      devOptions: {
        enabled: false
      },
      workbox: {
        disableDevLogs: true,
        globPatterns: [],
        runtimeCaching: [],
        navigateFallback: null,
        cleanupOutdatedCaches: true,
      },
      manifest: {
        name: 'Temp Email',
        short_name: 'Temp Email',
        description: 'Temp Email - Temporary Email',
        theme_color: '#ffffff',
        icons: [
          {
            src: '/logo.png',
            sizes: '192x192',
            type: 'image/png'
          }
        ]
      }
    })
  ],
  resolve: {
    alias: [
      {
        find: '@',
        replacement: fileURLToPath(new URL('./src', import.meta.url))
      }
    ]
  },
  define: {
    'import.meta.env.PACKAGE_VERSION': JSON.stringify(process.env.npm_package_version),
  }
})
