/**
 * The shell's public surface.
 *
 * Feature pages should import from `@/components/shell` rather than reaching into a
 * file, so the internal split between `nav.tsx`, `theme.ts` and the rest can change
 * without a cross-lane edit.
 */
export { Sidebar, type SidebarProps } from './sidebar';
export { Topbar, type TopbarProps } from './topbar';
export { MobileNav, type MobileNavProps } from './mobile-nav';
export { AccountMenu, type AccountMenuProps } from './account-menu';
export { PageHeader, type PageHeaderProps } from './page-header';
export { Brand, NavItems, OrganizationBadge, type NavProps } from './nav';
export { ThemeProvider, useTheme } from './theme-provider';
export { ThemeToggle, ThemeChoice } from './theme-toggle';
export {
  THEME_INIT_SCRIPT,
  THEME_PREFERENCES,
  THEME_STORAGE_KEY,
  DEFAULT_THEME_PREFERENCE,
  isThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from './theme';
