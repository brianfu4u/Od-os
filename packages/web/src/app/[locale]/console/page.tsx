import { setRequestLocale } from 'next-intl/server';
import { StaffConsole } from '../../../components/console/StaffConsole';

/**
 * Staff console (WeChat Mini Program stand-in). Server component pins the locale; the
 * console itself is a client component that POSTs reports/uploads/scans to the live API.
 */
export default async function ConsolePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <StaffConsole />;
}
