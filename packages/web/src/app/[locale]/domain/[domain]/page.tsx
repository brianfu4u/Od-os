import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '../../../../components/session/AppShell';
import { DomainDetail } from '../../../../components/domain/DomainDetail';
import { DOMAIN_KEYS, type DomainKey } from '../../../../lib/domains';

/** Prerender the six domain routes per locale (still client-fetched behind the session gate). */
export function generateStaticParams(): Array<{ domain: string }> {
  return DOMAIN_KEYS.map((domain) => ({ domain }));
}

export default async function DomainPage({ params }: { params: Promise<{ locale: string; domain: string }> }) {
  const { locale, domain } = await params;
  setRequestLocale(locale);
  if (!(DOMAIN_KEYS as readonly string[]).includes(domain)) notFound();
  return (
    <AppShell>
      <DomainDetail domain={domain as DomainKey} />
    </AppShell>
  );
}
