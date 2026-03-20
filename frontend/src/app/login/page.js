'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AuthGate } from '../../components/AuthGate';

export default function LoginPage() {
  return (
    <AuthGate>
      {() => <LoginRedirect />}
    </AuthGate>
  );
}

function LoginRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/dashboard');
  }, [router]);

  return null;
}
