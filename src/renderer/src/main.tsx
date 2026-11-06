import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

// Errors nothing caught go to main for the anonymous stats, which keep only their type and where
// in Plexo's own code they were thrown (see main/stats.ts).
function report(error: unknown): void {
  const {
    name = 'Error',
    message = String(error),
    stack
  } = error instanceof Error ? error : ({} as Partial<Error>)
  void window.plexo.reportError({ name, message, stack }).catch(() => {})
}
window.addEventListener('error', (event) => report(event.error))
window.addEventListener('unhandledrejection', (event) => report(event.reason))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
