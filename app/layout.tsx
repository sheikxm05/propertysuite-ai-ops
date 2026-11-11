import type { Metadata, Viewport } from 'next';

import { THEME_INIT_SCRIPT } from '@/components/shell/theme';
import { ThemeProvider } from '@/components/shell/theme-provider';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'PropertySuite AI Ops',
    template: '%s · PropertySuite AI Ops',
  },
  description:
    'Multi-tenant property operations with AI-assisted maintenance intake and human-verified document extraction.',
  // Private operational tool — keep it out of indexes entirely.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Both values are declared so the browser paints its own chrome — address bar, form
  // controls — to match whichever theme is active, rather than always the light one.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f8fb' },
    { media: '(prefers-color-scheme: dark)', color: '#0a111e' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AE" suppressHydrationWarning>
      <head>
        {/*
          The theme has to be on <html> before the first paint, and only the browser can
          read the stored preference. This script is synchronous and blocking by design:
          it is a few hundred bytes, it runs before the body renders, and it is the
          difference between a dark-mode user seeing their theme and seeing a white
          flash first. `suppressHydrationWarning` above is required because this script
          mutates the element React is about to hydrate.

          The content is a constant assembled in `components/shell/theme.ts` from string
          literals — nothing user-supplied can reach it, so there is no injection surface
          despite `dangerouslySetInnerHTML`.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
