/**
 * Theme preference — the data half, with no React and no DOM assumptions, so that
 * `app/layout.tsx` can import the bootstrap script from a server component.
 *
 * WHY THIS IS HAND-WRITTEN AND NOT `next-themes`
 * ----------------------------------------------
 * The dependency list is frozen in `docs/parallel-execution-plan.md` §5.1 and installed
 * once by lane w0-l1; CLAUDE.md rule 3 forbids adding to it. Everything the library
 * would give us is below in roughly forty lines: a stored preference, a `prefers-color-
 * scheme` fallback, a class on `<html>`, and a blocking script so the class is set
 * before first paint.
 *
 * THE FLASH PROBLEM
 * -----------------
 * The server cannot know the visitor's theme — it is in `localStorage`, which only the
 * browser can read, and reading it from React means reading it after hydration, which
 * means one frame of white page in a dark-themed browser. `THEME_INIT_SCRIPT` runs
 * synchronously in `<head>` before the body paints, so the correct class is already on
 * `<html>` when the first pixel is drawn. It is deliberately dependency-free, wrapped in
 * `try`/`catch` (Safari private mode throws on `localStorage`), and short enough to
 * inline rather than fetch.
 */

/** The `localStorage` key. Changing it silently resets everyone's preference. */
export const THEME_STORAGE_KEY = 'propertysuite-theme';

/** What the user chose. `system` means "keep following the operating system". */
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** What that choice resolves to right now. Only these two reach the DOM. */
export type ResolvedTheme = 'light' | 'dark';

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/**
 * Applies a resolved theme to the document element.
 *
 * `colorScheme` is set alongside the class so that native widgets the stylesheet cannot
 * reach — scrollbars, date pickers, form control chrome — follow the theme too. A dark
 * page with a white scrollbar is the detail that gives away a bolted-on dark mode.
 */
export function applyTheme(resolved: ResolvedTheme, preference: ThemePreference): void {
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
  root.dataset.themePreference = preference;
}

export function prefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

export function resolveTheme(preference: ThemePreference, systemIsDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemIsDark ? 'dark' : 'light';
  return preference;
}

export function readStoredPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : DEFAULT_THEME_PREFERENCE;
  } catch {
    // Private browsing modes throw on storage access. Following the OS is a safe answer.
    return DEFAULT_THEME_PREFERENCE;
  }
}

export function writeStoredPreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // A preference we cannot persist still applies for this session. Not worth failing.
  }
}

/**
 * The blocking bootstrap. Inlined into `<head>` by `app/layout.tsx`.
 *
 * Kept as a single-quoted string with no template interpolation so that nothing
 * user-controlled can ever reach it, and containing no `<` character, so it cannot
 * terminate the surrounding `<script>` element early.
 */
export const THEME_INIT_SCRIPT = [
  '(function(){try{',
  "var k='" + THEME_STORAGE_KEY + "';",
  'var s=window.localStorage.getItem(k);',
  "if(s!=='light'&&s!=='dark'&&s!=='system'){s='system';}",
  "var m=window.matchMedia('(prefers-color-scheme: dark)').matches;",
  "var d=s==='dark'||(s==='system'&&m);",
  'var e=document.documentElement;',
  "e.classList.toggle('dark',d);",
  "e.style.colorScheme=d?'dark':'light';",
  'e.dataset.themePreference=s;',
  '}catch(_){}})();',
].join('');
