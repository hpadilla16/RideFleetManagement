import { PublicSiteShell } from '../../components/PublicSiteShell';

export const metadata = {
  title: 'Ride Car Sharing Preview',
  description: 'Preview of the new public website connected to Ride Fleet APIs.'
};

export default function SitePreviewLayout({ children }) {
  return <PublicSiteShell>{children}</PublicSiteShell>;
}
