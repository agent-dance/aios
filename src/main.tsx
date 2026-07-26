import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AgentRuntimeProvider } from './agent-runtime';
import './styles/global.css';
import { useSystemStore } from './system/useSystemStore';

// The official web-game harness selects the largest canvas before it performs
// clicks. This development-only deep link mounts the requested game canvas on
// the first render, so the global assistant avatar cannot be mistaken for the
// game. Production URLs cannot mutate OS state through this seam.
if (import.meta.env.DEV) {
  const automationGame = new URLSearchParams(window.location.search).get('automationGame');
  if (automationGame === 'space-game') useSystemStore.getState().openApp('space-game');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AgentRuntimeProvider>
      <App />
    </AgentRuntimeProvider>
  </StrictMode>,
);
