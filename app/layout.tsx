import type { Metadata, Viewport } from 'next';
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
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AE" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
