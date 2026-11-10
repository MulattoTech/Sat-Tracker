import { Inter as FontSans } from 'next/font/google';
import { cn } from '@/src/lib/utils';
import { Metadata } from 'next';
import { LocalizationProvider } from '@/src/context/localization';
import { TimezoneProvider } from '@/app/context/timezone';
import { APPLE_TOUCH_ICON } from '@/src/utils/pwa-icons';
import './globals.css';

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover' as const,
  themeColor: '#0d9488',
};

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NODE_ENV === 'production' ? 'https://tracker.m-techlabs.com' : 'http://localhost:3000'),
  title: 'Sat Tracker',
  icons: {
    icon: '/sat-tracker.svg',
    shortcut: '/sat-tracker.svg',
    apple: APPLE_TOUCH_ICON,
  },
  description: 'Track your baby\'s sleep, feeding, diapers, milestones, and more with our intuitive, family-friendly platform. Simple to use, privacy-focused, accessible anywhere.',
  keywords: [
    'baby tracker',
    'baby tracking app', 
    'infant care',
    'baby feeding tracker',
    'baby sleep tracker',
    'diaper tracker',
    'baby milestones',
    'newborn care',
    'baby care app',
    'family tracking',
    'caretaker coordination',
    'baby activities',
    'parenting tools'
  ],
  authors: [{ name: 'M-TechLabs' }, { name: 'Oak and Sprout (Sprout Track)' }],
  creator: 'M-TechLabs',
  publisher: 'M-TechLabs',
  robots: {
    index: false,
    follow: false,
    googleBot: {
      index: false,
      follow: false,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: 'https://tracker.m-techlabs.com',
    title: 'Sat Tracker - The Shareable Baby Tracking Solution',
    description: 'Track your baby\'s sleep, feeding, diapers, milestones, and more with our intuitive, family-friendly platform. Simple to use, privacy-focused, accessible anywhere.',
    siteName: 'Sat Tracker',
    images: [
      {
        url: '/sat-tracker-512.png',
        width: 256,
        height: 256,
        alt: 'Sat Tracker Logo - Baby Tracking App',
      },
    ],
  },
  verification: {
    google: '', // Add Google Search Console verification code when available
  },
  alternates: {
    canonical: 'https://tracker.m-techlabs.com',
  },
  manifest: '/manifest.json',
  other: {
    'apple-mobile-web-app-capable': 'yes',
    'apple-mobile-web-app-status-bar-style': 'black-translucent',
  },
  category: 'technology',
};

const fontSans = FontSans({
  subsets: ['latin'],
  variable: '--font-sans',
});

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Layout is now responsible only for rendering - redirect logic moved to individual pages

  return (
    <html lang="en" className={cn('h-full', fontSans.variable)} suppressHydrationWarning>
      <body className={cn('min-h-full bg-gradient-to-br from-indigo-100 via-purple-50 to-pink-50 dark:bg-gradient-to-br dark:from-gray-900 dark:via-gray-800 dark:to-gray-900 font-sans antialiased')} suppressHydrationWarning>
        <LocalizationProvider>
          <TimezoneProvider>
            {children}
          </TimezoneProvider>
        </LocalizationProvider>
      </body>
    </html>
  );
}
