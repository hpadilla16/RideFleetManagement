import '@testing-library/jest-dom';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// Mock next/link
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }) => {
    const React = require('react');
    return React.createElement('a', { href, ...props }, children);
  },
}));
