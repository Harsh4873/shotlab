export type Theme = "light" | "dark";

/**
 * Shared with the other apps on this domain, so a theme chosen on the landing
 * page carries into ShotLab and back.
 */
export const THEME_STORAGE_KEY = "harsh-theme";

const LIGHT_QUERY = "(prefers-color-scheme: light)";

/**
 * Inlined into <head> so the theme is resolved before the first paint and the
 * page never flashes the wrong palette. Kept as a string because it has to run
 * during document parsing, ahead of React.
 *
 * Resolution order: an explicit saved choice wins, then the OS preference, and
 * dark is the final fallback. Must stay in step with resolveTheme() below.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var s=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});document.documentElement.dataset.theme=s==="light"||s==="dark"?s:matchMedia(${JSON.stringify(
  LIGHT_QUERY,
)}).matches?"light":"dark"}catch(e){document.documentElement.dataset.theme="dark"}})();`;

/** The user's explicit choice, or null if they have never picked one. */
export function storedTheme(): Theme | null {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : null;
  } catch {
    return null;
  }
}

export function systemTheme(): Theme {
  try {
    return matchMedia(LIGHT_QUERY).matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function resolveTheme(): Theme {
  return storedTheme() ?? systemTheme();
}

/** Whatever the pre-paint resolver already put on <html>. */
export function activeTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private-mode storage failures should not stop the theme from applying.
  }
}

/**
 * Follow the OS while the user has no explicit preference of their own.
 * Returns an unsubscribe function.
 */
function watchSystemTheme(onChange: (theme: Theme) => void): () => void {
  try {
    const query = matchMedia(LIGHT_QUERY);
    const handler = (event: MediaQueryListEvent) => {
      if (storedTheme()) return;
      onChange(event.matches ? "light" : "dark");
    };
    query.addEventListener("change", handler);
    return () => query.removeEventListener("change", handler);
  } catch {
    return () => {};
  }
}

/*
 * The theme is owned by <html>, not by React, so components read it through
 * useSyncExternalStore. One media-query subscription is shared by every
 * listener, which also keeps multiple toggles in step with each other.
 */
const listeners = new Set<() => void>();
let unwatchSystem: (() => void) | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeTheme(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  if (!unwatchSystem) {
    unwatchSystem = watchSystemTheme((next) => {
      applyTheme(next);
      emit();
    });
  }
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0) {
      unwatchSystem?.();
      unwatchSystem = null;
    }
  };
}

export const getThemeSnapshot = activeTheme;

/** Pre-hydration snapshot; the inline resolver corrects <html> before paint. */
export function getServerThemeSnapshot(): Theme {
  return "dark";
}

/** Record an explicit user choice and apply it. */
export function chooseTheme(theme: Theme): void {
  persistTheme(theme);
  applyTheme(theme);
  emit();
}
