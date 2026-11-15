import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Telegram API credentials bundled into release builds (see src/main/telegram/service.ts):
// whoever cuts a release sets TELEGRAM_API_ID/HASH (CI secrets), so users sign in with just
// their phone. Unset in dev builds — the app then asks for the user's own credentials.
const telegramDefine = {
  __PLEXO_TG_API_ID__: JSON.stringify(
    process.env.TELEGRAM_API_ID ? Number(process.env.TELEGRAM_API_ID) : undefined
  ),
  __PLEXO_TG_API_HASH__: JSON.stringify(process.env.TELEGRAM_API_HASH || undefined)
}

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    define: telegramDefine
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
