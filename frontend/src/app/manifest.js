export default function manifest() {
  return {
    name: 'Ride Fleet',
    short_name: 'Ride Fleet',
    description: 'Mobile-first rental, host, guest, employee, and loaner operations platform.',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f6f3ff',
    theme_color: '#6e49ff',
    icons: [
      {
        src: '/ride-logo.png',
        sizes: '192x192',
        type: 'image/png'
      },
      {
        src: '/ride-logo.png',
        sizes: '512x512',
        type: 'image/png'
      },
      {
        src: '/ride-logo.png',
        sizes: '180x180',
        type: 'image/png',
        purpose: 'any'
      }
    ]
  };
}
