'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AgreementInspectionDeprecatedPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/reservations');
  }, [router]);
  return null;
}
