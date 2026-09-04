/** Where the world server lives. Override with VITE_SERVER_URL at build/dev time. */
export const SERVER_URL: string =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ?? `ws://${location.hostname}:8787`;

/** Render remote players this many seconds in the past, so interpolation always
 *  has two real samples to blend between (the classic entity-interpolation trick). */
export const INTERP_DELAY = 0.12;
