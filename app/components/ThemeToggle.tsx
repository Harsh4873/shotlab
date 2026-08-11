"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

import {
  chooseTheme,
  getServerThemeSnapshot,
  getThemeSnapshot,
  subscribeTheme,
  type Theme,
} from "../lib/theme";

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  // The theme lives on <html>, set before hydration by the inline resolver, so
  // it is an external store rather than React state.
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getServerThemeSnapshot);

  const light = theme === "light";
  const next: Theme = light ? "dark" : "light";

  return (
    <button
      className={`theme-toggle${compact ? " compact" : ""}`}
      type="button"
      role="switch"
      aria-checked={light}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => chooseTheme(next)}
    >
      {light ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}
      {compact ? null : <span>{light ? "Light" : "Dark"}</span>}
    </button>
  );
}
