import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './components/ErrorBoundary';
import { VersionBadge } from './components/VersionBadge';
import { App } from './App';
import { CarouselArrowProvider } from './components/CarouselArrowContext';
import { DesktopFrame } from './components/DesktopFrame';
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/playfair-display/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import './styles/global.css';
import './styles/carousel.css';
import './styles/desktop-frame.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <CarouselArrowProvider>
        <DesktopFrame>
          <App />
        </DesktopFrame>
      </CarouselArrowProvider>
      {import.meta.env.DEV && <VersionBadge />}
    </ErrorBoundary>
  </StrictMode>
);
