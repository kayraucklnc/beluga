import { Fragment, StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { SocketClient } from '@klaud/ipc/socket-client.js';
import { App } from './App.js';
import { brandText } from './lib/brand.js';
import { capabilities, connect, inApp } from './lib/boot.js';
import { KlaudProvider } from './lib/klaud.js';
import { apply, zoom } from './lib/prefs.js';
import { watchWindow } from './lib/window-active.js';
import { Button } from './components/ui.js';
import { UpdateLayer } from './dialogs/UpdateSheet.js';
import s from './layout/Shell.module.css';
import './styles/tokens.css';
import './styles/base.css';

apply();
if (inApp()) document.documentElement.dataset.app = 'tauri';
watchWindow();

/** Attach to klaud, and keep trying while it starts (or comes back). */
function Root() {
  const [client, setClient] = useState<SocketClient>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);
  useEffect(() => {
    let alive = true;
    // Waits longer each time in a row it fails (up to 10 s), so a broken klaud isn't hammered.
    const retry = (): void => void setTimeout(() => alive && setAttempt((n) => n + 1), Math.min(10_000, 500 * 2 ** Math.min(failures.current++, 5)));
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Klaud didn't answer")), 15_000));
    Promise.race([connect(capabilities(zoom)), timeout])
      .then((c) => {
        if (!alive) return c.close();
        setError(undefined);
        setClient(c);
        const since = Date.now();
        c.onClose(() => {
          setClient(undefined);
          // Dropped right away (klaud turned the screen away): wait before trying again.
          if (Date.now() - since < 5000) return retry();
          failures.current = 0;
          setAttempt((n) => n + 1);
        });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
        retry();
      });
    return () => {
      alive = false;
    };
  }, [attempt]);
  if (!client) {
    return (
      <div className={s.connecting} data-tauri-drag-region>
        <UpdateLayer connected={false} />
        <div className={s.connectBox}>
          <strong>{error ? 'Klaud isn’t running yet' : 'Starting Klaud…'}</strong>
          {error ? <span>{brandText(error)}</span> : null}
          {error ? <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button> : null}
        </div>
      </div>
    );
  }
  return (
    <KlaudProvider client={client}>
      <App />
      <UpdateLayer connected />
    </KlaudProvider>
  );
}

/**
 * StrictMode draws everything twice while developing (never in the app you ship): a timing test
 * (e2e/render-calm.spec.ts) opens `/?nostrict` to time what the app itself does.
 */
const Strict = import.meta.env.DEV && new URLSearchParams(location.search).has('nostrict') ? Fragment : StrictMode;

createRoot(document.getElementById('root')!).render(
  <Strict>
    <Root />
  </Strict>,
);
