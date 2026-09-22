// A minimal store: set() merges a patch and tells subscribers which keys changed.

export function createStore(initial) {
  let state = { ...initial };
  const subs = new Set();
  return {
    get: () => state,
    set(patch) {
      const changed = new Set();
      for (const k of Object.keys(patch)) if (state[k] !== patch[k]) changed.add(k);
      if (!changed.size) return;
      state = { ...state, ...patch };
      // One view failing to render must not stop the others from updating.
      for (const fn of subs) {
        try {
          fn(state, changed);
        } catch (e) {
          console.error('Vidscope view update failed:', e);
        }
      }
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem(`vidscope:${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function savePref(key, value) {
  try {
    localStorage.setItem(`vidscope:${key}`, JSON.stringify(value));
  } catch {
    // Preferences are a convenience; private windows may refuse storage.
  }
}
