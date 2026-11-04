import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { useUI } from './store'

// test builds expose a camera hook so end-to-end tests and README screenshots can frame the scene
if (import.meta.env.MODE === 'e2e') {
  ;(window as unknown as { __focus: (x: number, z: number, d: number) => void }).__focus = (x, z, d) => useUI.getState().focusOn(x, z, d)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
