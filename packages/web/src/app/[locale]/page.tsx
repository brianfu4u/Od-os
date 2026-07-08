import { setRequestLocale } from 'next-intl/server';
import { CommandCenter } from '../../components/cc/CommandCenter';

/**
 * Command center — the live operations cockpit. This server component only pins the
 * request locale; all data fetching happens client-side in <CommandCenter/> (live API +
 * SSE), so the static prerender stays data-free and renders an offline state when the API
 * is down.
 */
export default async function CommandCenterPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <CommandCenter />;
}
