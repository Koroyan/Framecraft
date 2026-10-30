import type { Metadata, Viewport } from 'next';
import { Geist, Instrument_Serif, Noto_Sans_Georgian } from 'next/font/google';
import { Providers } from '@/components/providers';
import './globals.css';

const geist = Geist({ subsets: ['latin', 'cyrillic'], variable: '--font-geist', display: 'swap' });
const instrument = Instrument_Serif({ subsets: ['latin'], weight: '400', style: ['normal', 'italic'], variable: '--font-instrument', display: 'swap' });
const georgian = Noto_Sans_Georgian({ subsets: ['georgian'], variable: '--font-georgian', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Framecraft — AI video & film studio', template: '%s · Framecraft' },
  description: 'Create TikToks, Reels, ads and multi-scene AI films. Framecraft picks the best AI video model for every shot at the lowest practical cost.',
  applicationName: 'Framecraft',
};

export const viewport: Viewport = {
  themeColor: '#090b13',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${instrument.variable} ${georgian.variable}`}>
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
