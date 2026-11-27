import './assets/main.css'

import { initRendererI18n } from './i18n'
import { useAppStore } from './store/useAppStore'

async function enableRendererReporting(): Promise<void> {
  try {
    const { init, globalHandlersIntegration } = await import('@sentry/electron/renderer')
    init({
      defaultIntegrations: false,
      integrations: [globalHandlersIntegration()],
      maxBreadcrumbs: 0,
      dataCollection: { userInfo: false },
      beforeSend: (event) => (useAppStore.getState().v1ErrorReporting === true ? event : null)
    })
  } catch {
    console.error('Could not initialize renderer error reporting')
  }
}

async function start(): Promise<void> {
  await initRendererI18n(window.plexo.initialState.language)

  if (window.plexo.initialState.reportingAvailability === 'configured') {
    // No renderer client until the first consent. Main checks again at the transport boundary.
    if (useAppStore.getState().v1ErrorReporting) await enableRendererReporting()
    else {
      const unsubscribe = useAppStore.subscribe((state) => {
        if (state.v1ErrorReporting) {
          unsubscribe()
          void enableRendererReporting()
        }
      })
    }
  }

  await import('./renderApp')
}

void start()
