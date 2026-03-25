import Link from 'next/link';

export const metadata = {
  title: 'Privacy Policy | Ride Fleet',
  description: 'Privacy Policy for Ride Fleet web, mobile, guest, host, employee, and dealership loaner experiences.'
};

const sections = [
  {
    title: 'Overview',
    body: [
      'Ride Fleet provides reservation, customer portal, host, employee, support, car sharing, and dealership loaner workflows through web and mobile experiences.',
      'This Privacy Policy explains what information we collect, how we use it, when we share it, and what choices users have when using Ride Fleet.'
    ]
  },
  {
    title: 'Information We Collect',
    body: [
      'We may collect account details such as name, email address, phone number, company or tenant affiliation, and role-based access information.',
      'We may collect reservation, trip, vehicle, payment, billing, agreement, inspection, issue, and dealership service-lane data needed to operate the platform.',
      'We may collect documents and media uploads such as driver license images, insurance documents, registration documents, inspection photos, issue evidence, and host vehicle photos.',
      'We may collect technical information such as device type, browser, operating system, app wrapper environment, approximate network information, and usage logs.'
    ]
  },
  {
    title: 'How We Use Information',
    body: [
      'We use information to authenticate users, operate reservations and loaner workflows, process payments, manage support issues, generate agreements and printouts, and maintain audit history.',
      'We use information to improve product performance, reliability, and security across guest, host, employee, admin, and customer service experiences.',
      'We may use contact information to send booking confirmations, payment links, pre-check-in links, issue updates, vehicle approval requests, host review requests, and other transactional communications.'
    ]
  },
  {
    title: 'How Information Is Shared',
    body: [
      'Information may be shared with the tenant or business operating your booking, reservation, dealership, fleet, or marketplace workflow.',
      'Information may be shared with service providers used to operate Ride Fleet, including payment gateways, email providers, cloud hosting providers, document generation services, and storage providers.',
      'Information may be shared when reasonably necessary to resolve disputes, investigate misuse, comply with legal obligations, or protect users, tenants, Ride Fleet, or the public.'
    ]
  },
  {
    title: 'Payments And Financial Data',
    body: [
      'Ride Fleet may support different payment gateways by tenant. Payment details may be processed by third-party payment providers rather than stored directly by Ride Fleet.',
      'Billing, payment status, and transaction metadata may still be stored inside Ride Fleet to support operations, reporting, customer service, and audit history.'
    ]
  },
  {
    title: 'Documents, Photos, And Evidence',
    body: [
      'Documents and uploaded media may be used to complete pre-check-in, verify drivers, review host vehicle approvals, compare inspections, support dispute resolution, and document dealership loaner workflows.',
      'Users should only upload information that is relevant to the workflow they are completing.'
    ]
  },
  {
    title: 'Data Retention',
    body: [
      'Ride Fleet may retain account, reservation, issue, and loaner records for operational, accounting, compliance, reporting, support, and audit purposes.',
      'Retention periods may vary by tenant, workflow type, legal obligation, or dispute history.'
    ]
  },
  {
    title: 'Security',
    body: [
      'Ride Fleet uses role-based access controls, tenant scoping, user module access controls, and workflow-level audit logging to help protect platform data.',
      'No system can guarantee absolute security, so users and tenants should also protect credentials, devices, uploaded files, and internal access policies.'
    ]
  },
  {
    title: 'Your Choices',
    body: [
      'Guests, hosts, employees, and tenant administrators may request updates to account or profile information through the business or tenant operating their workflow.',
      'Users may choose whether to continue certain uploads or communications, but some information is required in order to complete reservations, payments, agreements, inspections, vehicle approvals, or support workflows.'
    ]
  },
  {
    title: 'Children',
    body: [
      'Ride Fleet is not intended for use by children under the age required to lawfully create accounts, drive vehicles, enter agreements, or complete the underlying business workflow.'
    ]
  },
  {
    title: 'International And Tenant-Specific Operations',
    body: [
      'Ride Fleet may support multiple tenants, rooftops, and operators. Data handling practices can vary depending on the tenant configuration, payment provider, geography, and legal obligations that apply to that tenant.'
    ]
  },
  {
    title: 'Policy Updates',
    body: [
      'Ride Fleet may update this Privacy Policy from time to time as features, workflows, or legal requirements evolve. Continued use of the platform after an update may be treated as acceptance of the updated policy where permitted by law.'
    ]
  },
  {
    title: 'Contact',
    body: [
      'For privacy questions, data requests, or platform support inquiries, contact the Ride Fleet team or the tenant operating your booking or workflow.',
      'General contact: ops@ridefleetmanager.com'
    ]
  }
];

export default function PrivacyPolicyPage() {
  return (
    <main className="legal-shell">
      <section className="glass card-lg legal-hero">
        <span className="eyebrow">Ride Fleet Legal</span>
        <h1 className="legal-title">Privacy Policy</h1>
        <p className="legal-lead">
          This policy explains how Ride Fleet handles information across the marketplace,
          guest portal, host workflows, employee tools, issue center, and dealership loaner program.
        </p>
        <div className="hero-meta">
          <span className="hero-pill">Effective Date: March 25, 2026</span>
          <span className="hero-pill">Applies To Web And Mobile</span>
          <span className="hero-pill">ridefleetmanager.com</span>
        </div>
        <div className="inline-actions">
          <Link href="/" className="legal-link-pill">Back To Ride Fleet</Link>
          <Link href="/book" className="legal-link-pill">Open Marketplace</Link>
          <Link href="/guest" className="legal-link-pill">Open Guest Portal</Link>
        </div>
      </section>

      <section className="legal-layout">
        <aside className="glass card legal-nav">
          <div className="label">Sections</div>
          <div className="stack" style={{ gap: 8 }}>
            {sections.map((section) => (
              <a key={section.title} href={`#${section.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`} className="legal-nav-link">
                {section.title}
              </a>
            ))}
          </div>
        </aside>

        <div className="legal-content">
          {sections.map((section) => {
            const id = section.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            return (
              <section key={section.title} id={id} className="glass card-lg legal-section">
                <h2>{section.title}</h2>
                <div className="stack">
                  {section.body.map((item) => (
                    <p key={item}>{item}</p>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </section>
    </main>
  );
}
