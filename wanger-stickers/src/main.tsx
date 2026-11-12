import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './studio/studio.css';

// ?spike=1 keeps the Phase 0 device test page reachable (owner panel → «🧪 تست دستگاه»).
const params = new URLSearchParams(location.search);
const Page = params.get('spike') ? lazy(() => import('./App.tsx')) : lazy(() => import('./studio/Studio.tsx'));

const tg = window.Telegram?.WebApp;
tg?.ready?.();
tg?.expand?.();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  </StrictMode>,
);
