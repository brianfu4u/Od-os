import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '../../components/session/AppShell';
import { CommandCenter } from '../../components/cc/CommandCenter';

/**
 * Command center — the live operations cockpit. This server component only pins the request locale;
 * <AppShell/> gates on a manager session (client-side), and <CommandCenter/> fetches everything from
 * the live API + SSE, so the static prerender stays data-free and shows the login when signed out.
 */
export default async function CommandCenterPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <AppShell>
      <CommandCenter />
    </AppShell>
  );
}
