import { h, render, Fragment, createContext, Component } from '../../vendor/preact/preact.module.js';
import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useContext, useReducer } from '../../vendor/preact/hooks.module.js';
import htm from '../../vendor/htm/htm.module.js';

export const html = htm.bind(h);
export { h, render, Fragment, createContext, Component, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useContext, useReducer };

/**
 * Re-renders when an EventTarget fires `change`. Emitters bump `target._v` so changes that
 * happen between render and subscription are not missed.
 */
export function useChange(target, filter) {
  const [, force] = useReducer((x) => x + 1, 0);
  const seen = useRef(target?._v);
  seen.current = target?._v;
  useLayoutEffect(() => {
    if (!target) return undefined;
    const onChange = (e) => {
      if (!filter || filter(e.detail || {})) force();
    };
    target.addEventListener('change', onChange);
    if (target._v !== seen.current) force();
    return () => target.removeEventListener('change', onChange);
  }, [target]);
}
