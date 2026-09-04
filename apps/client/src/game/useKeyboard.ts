import { useEffect, useRef, type MutableRefObject } from 'react';

/** Tracks raw key-down state by `event.code`, cleared on blur so a held key can't
 *  get "stuck" when the window loses focus. */
export function useKeyboard(): MutableRefObject<Record<string, boolean>> {
  const keys = useRef<Record<string, boolean>>({});
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      keys.current[e.code] = true;
    };
    const up = (e: KeyboardEvent): void => {
      keys.current[e.code] = false;
    };
    const clear = (): void => {
      keys.current = {};
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
    };
  }, []);
  return keys;
}

/** True while the player is typing in a text field, so movement keys are ignored. */
export function isTyping(): boolean {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}
