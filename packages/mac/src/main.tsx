import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { SocketClient } from '@klaud/ipc/socket-client.js';
import { App } from './App.js';
import { capabilities, connect, inApp } from './lib/boot.js';
import { KlaudProvider } from './lib/klaud.js';
import { apply, zoom } from './lib/prefs.js';
import { Button } from './components/ui.js';
import s from './layout/Shell.module.css';
import './styles/tokens.css';
import './styles/base.css';

apply();
if (inApp()) document.documentElement.dataset.app = 'tauri';

/** Attach to klaud, and keep trying while it starts (or comes back). */
function Root() {
  const [client, setClient] = useState<SocketClient>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    connect(capabilities(zoom))
      .then((c) => {
        if (!alive) return c.close();
        setError(undefined);
        setClient(c);
        c.onClose(() => {
          setClient(undefined);
          setAttempt((n) => n + 1);
        });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
        setTimeout(() => alive && setAttempt((n) => n + 1), 1500);
      });
    return () => {
      alive = false;
    };
  }, [attempt]);
  if (!client) {
    return (
      <div className={s.connecting} data-tauri-drag-region>
        <div className={s.connectBox}>
          <strong>{error ? 'klaud isn’t running yet' : 'Starting klaud…'}</strong>
          {error ? <span>{error}</span> : null}
          {error ? <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button> : null}
        </div>
      </div>
    );
  }
  return (
    <KlaudProvider client={client}>
      <App />
    </KlaudProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
