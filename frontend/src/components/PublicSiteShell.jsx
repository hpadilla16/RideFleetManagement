import Link from 'next/link';
import styles from './PublicSiteShell.module.css';

const navItems = [
  { href: '/site-preview', label: 'Home' },
  { href: '/site-preview/rent', label: 'Rent' },
  { href: '/site-preview/car-sharing', label: 'Car Sharing' },
  { href: '/site-preview/fleet', label: 'Fleet' },
  { href: '/site-preview/contact', label: 'Contact' }
];

export function PublicSiteShell({ children }) {
  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <Link href="/site-preview" className={styles.brand}>
            <span className={styles.brandMark}>R</span>
            <span className={styles.brandText}>
              <span className={styles.eyebrow}>Ride Car Sharing</span>
              <span className={styles.name}>Connected Guest Website</span>
              <span className={styles.tagline}>A modern booking layer powered by Ride Fleet operations.</span>
            </span>
          </Link>
          <nav className={styles.nav}>
            {navItems.map((item) => (
              <Link key={item.href} href={item.href} className={styles.navLink}>
                {item.label}
              </Link>
            ))}
            <Link href="/book" className={styles.navButton}>
              Start Booking
            </Link>
          </nav>
        </header>

        {children}

        <footer className={`${styles.card} ${styles.footer}`}>
          <span>Preview branch for the new ride-carsharing.com customer website.</span>
          <div className={styles.footerLinks}>
            <Link href="/site-preview/rent">Daily Rentals</Link>
            <Link href="/site-preview/car-sharing">Car Sharing</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/become-a-host">Become a Host</Link>
          </div>
        </footer>
      </div>
    </div>
  );
}
