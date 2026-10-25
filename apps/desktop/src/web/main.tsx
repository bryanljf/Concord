import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '../renderer/theme.css';
import { createWebApi } from './api';

// The renderer reads `window.concord` as soon as its modules run, so the bridge must exist
// before `App` is loaded: hence the dynamic import after the assignment (a static import would
// be hoisted above it).
window.concord = createWebApi();

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

void import('../renderer/App').then(({ App }) => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
