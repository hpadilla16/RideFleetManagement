'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AuthGate } from '../../components/AuthGate';
import { preferredAppRoute } from '../../lib/moduleAccess';

export default function LoginPage() {
  return (
    <AuthGate>
      {({ me }) => <LoginRedirect me={me} />}
    </AuthGate>
  );
}

function LoginRedirect({ me }) {
  const router = useRouter();

  useEffect(() => {
    router.replace(preferredAppRoute(me));
  }, [me, router]);

  return null;
}
