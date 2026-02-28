import './globals.css';

export const metadata = {
  title: 'Fleet Management Dashboard',
  description: 'Operations dashboard for fleet and reservations'
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
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        {children}
      </body>
    </html>
  );
}
