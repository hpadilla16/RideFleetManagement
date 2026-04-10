import './globals.css';
import { SentryBoot } from '../components/SentryBoot';
import { I18nBoot } from '../components/I18nBoot';

export const metadata = {
  title: 'Ride Fleet',
  description: 'Mobile-first rental, host, guest, employee, and loaner operations platform.',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Ride Fleet'
  },
  icons: {
    icon: [
      { url: '/ride-logo.png', sizes: '192x192', type: 'image/png' },
      { url: '/ride-logo.png', sizes: '512x512', type: 'image/png' }
    ],
    apple: [
      { url: '/ride-logo.png', sizes: '180x180', type: 'image/png' }
    ]
  }
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#6e49ff'
};

const themeBootScript = `
(function () {
  try {
    var dark = localStorage.getItem('ui.darkMode') === '1';
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (e) {}
})();
`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <SentryBoot />
        <I18nBoot />
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        {children}
      </body>
    </html>
  );
}
