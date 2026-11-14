/**
 * Entry point. The trial lifecycle is: bind an ephemeral port, register that
 * port with the environment, serve until the environment reports done, then
 * exit 0. When MAKEFUN_ENV_URL is unset the server runs standalone on PORT
 * (an ephemeral port by default, printed to stderr) for local testing.
 */

import { createApp } from './app.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envUrlOf(): string | null {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined || raw.trim() === '') return null;
  return raw.replace(/\/+$/, '');
}

async function register(envUrl: string, port: number): Promise<boolean> {
  const deadline = Date.now() + 60_000;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok || response.status === 409) return true;
      console.error(`register attempt ${attempt}: the environment answered HTTP ${response.status}`);
    } catch (error) {
      console.error(
        `register attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(5_000, 500 * 2 ** Math.min(attempt, 4)));
  }
}

async function waitUntilDone(envUrl: string): Promise<void> {
  let failures = 0;
  for (;;) {
    let done = false;
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        const data = (await response.json()) as { done?: unknown };
        failures = 0;
        done = data.done === true;
      } else {
        failures += 1;
      }
    } catch {
      failures += 1;
    }
    if (done) return;
    const wait = failures === 0 ? 1_000 : Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5));
    await sleep(wait);
  }
}

async function main(): Promise<number> {
  const viewerLogin = process.env.FORGE_VIEWER_LOGIN ?? 'adaiversen';
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  const server = createApp({ viewerLogin, token });

  const envUrl = envUrlOf();
  const requestedPort = envUrl === null ? Number.parseInt(process.env.PORT ?? '0', 10) || 0 : 0;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    console.error('the server bound to an unusable address');
    return 1;
  }
  const port = address.port;

  if (envUrl === null) {
    console.error(`forge listening standalone on http://127.0.0.1:${port} (viewer: ${viewerLogin})`);
    // Keep serving until the process is stopped.
    await new Promise<void>(() => {});
    return 0;
  }

  const registered = await register(envUrl, port);
  if (!registered) {
    console.error('could not register with the environment; giving up');
    server.close();
    return 1;
  }
  console.error(`forge listening on port ${port}, registered with the environment`);
  await waitUntilDone(envUrl);
  console.error('the environment reports done; shutting down');
  server.closeAllConnections();
  server.close();
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('fatal:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
