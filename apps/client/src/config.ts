/**
 * Where the world server lives.
 *  - dev (http://localhost): talk to the local server on :8787
 *  - prod (https://…): same-origin secure WebSocket proxied by Caddy at /ws
 * Override explicitly with VITE_SERVER_URL at build time if needed.
 */
export const SERVER_URL: string =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ??
  (location.protocol === 'https:' ? `wss://${location.host}/ws` : `ws://${location.hostname}:8787`);

/** Render remote players this many seconds in the past, so interpolation always
 *  has two real samples to blend between (the classic entity-interpolation trick). */
export const INTERP_DELAY = 0.12;
