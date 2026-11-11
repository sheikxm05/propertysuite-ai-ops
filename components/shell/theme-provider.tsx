'use client';

import * as React from 'react';

import {
  DEFAULT_THEME_PREFERENCE,
  THEME_STORAGE_KEY,
  applyTheme,
  isThemePreference,
  prefersDark,
  readStoredPreference,
  resolveTheme,
  writeStoredPreference,
  type ResolvedTheme,
  type ThemePreference,
} from './theme';

interface ThemeContextValue {
  /** What the user chose: `light`, `dark` or `system`. */
  readonly preference: ThemePreference;
  /** What that currently resolves to. */
  readonly resolved: ResolvedTheme;
  /**
   * False until the first client effect has run. Controls that render differently per
   * theme must hold a theme-neutral shape until this flips, or the hydrated markup will
   * not match the server's (the server cannot see `localStorage`).
   */
  readonly ready: boolean;
  setPreference: (next: ThemePreference) => void;
  /** Light ⇄ dark from wherever we are now, abandoning `system`. */
  toggle: () => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

/**
 * Client-side theme state.
 *
 * It does NOT paint the initial theme — `THEME_INIT_SCRIPT` in `<head>` already did that
 * before the first frame. This provider's job is everything after: reading the stored
 * preference into React state, following the OS while the preference is `system`,
 * persisting an explicit choice, and keeping two open tabs in agreement.
 *
 * The initial render deliberately matches the server (`system`, light) and corrects
 * itself in an effect. That costs one re-render and buys a hydration tree that is
 * identical on both sides — the alternative, guessing in render, is exactly the bug that
 * makes hand-rolled theme switches log hydration errors.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] =
    React.useState<ThemePreference>(DEFAULT_THEME_PREFERENCE);
  const [systemIsDark, setSystemIsDark] = React.useState(false);
  const [ready, setReady] = React.useState(false);

  // Adopt whatever the bootstrap script already decided, without re-deciding it.
  React.useEffect(() => {
    setPreferenceState(readStoredPreference());
    setSystemIsDark(prefersDark());
    setReady(true);
  }, []);

  // Follow the operating system for as long as the preference is `system`.
  React.useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = (event: MediaQueryListEvent) => setSystemIsDark(event.matches);
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  // A second tab changing the theme should not leave this one disagreeing with storage.
  React.useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      setPreferenceState(isThemePreference(event.newValue) ? event.newValue : 'system');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const resolved = resolveTheme(preference, systemIsDark);

  React.useEffect(() => {
    if (!ready) return;
    applyTheme(resolved, preference);
  }, [ready, resolved, preference]);

  const setPreference = React.useCallback((next: ThemePreference) => {
    writeStoredPreference(next);
    setPreferenceState(next);
  }, []);

  const value = React.useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolved,
      ready,
      setPreference,
      toggle: () => setPreference(resolved === 'dark' ? 'light' : 'dark'),
    }),
    [preference, resolved, ready, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Theme state for a client component.
 *
 * Throws when used outside the provider rather than returning a silent default: a theme
 * control that renders but does nothing is harder to notice than a crash in development.
 */
export function useTheme(): ThemeContextValue {
  const context = React.useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used inside <ThemeProvider> (mounted in app/layout.tsx).');
  }
  return context;
}
