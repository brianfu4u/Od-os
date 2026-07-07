import { getTranslations, setRequestLocale } from 'next-intl/server';
import { LocaleSwitcher } from '../../components/LocaleSwitcher';
import { StoragePref } from '../../components/StoragePref';

const LOOP_STAGES = ['sense', 'map', 'verify', 'reason', 'recommend', 'act', 'learn'] as const;
const DOMAINS = ['staff', 'patients', 'financial', 'marketing', 'equipment', 'inventory'] as const;

export default async function CommandCenterPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-6xl px-[5%] py-10">
        {/* header */}
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-sky-400" />
              <h1 className="text-2xl font-bold tracking-tight">{t('app.title')}</h1>
              <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
                {t('app.badge')}
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-400">{t('app.subtitle')}</p>
          </div>
          <LocaleSwitcher />
        </header>

        {/* agentic loop bar */}
        <section className="mt-10">
          <p className="text-xs uppercase tracking-widest text-slate-500">{t('loop.label')}</p>
          <ol className="mt-3 flex flex-wrap items-center gap-2">
            {LOOP_STAGES.map((stage, i) => (
              <li key={stage} className="flex items-center gap-2">
                <span className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1.5 text-sm">
                  <span className="mr-1.5 text-slate-500">{i + 1}</span>
                  {t(`loop.stages.${stage}`)}
                </span>
                {i < LOOP_STAGES.length - 1 ? <span className="text-slate-600">→</span> : null}
              </li>
            ))}
          </ol>
        </section>

        {/* command center */}
        <section className="mt-10">
          <h2 className="text-lg font-semibold">{t('cc.heading')}</h2>
          <p className="text-sm text-slate-400">{t('cc.tagline')}</p>

          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {DOMAINS.map((domain) => (
              <div
                key={domain}
                className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 transition-colors hover:border-slate-700"
              >
                <h3 className="text-base font-semibold text-slate-100">{t(`domains.${domain}`)}</h3>
                <p className="mt-2 text-xs text-slate-500">{t('domains.pending')}</p>
              </div>
            ))}
          </div>
        </section>

        {/* cues + storage demo */}
        <section className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
            <h3 className="text-sm font-semibold text-slate-200">{t('cues.title')}</h3>
            <p className="mt-3 text-sm text-slate-500">{t('cues.empty')}</p>
          </div>
          <StoragePref />
        </section>

        {/* footer */}
        <footer className="mt-12 border-t border-slate-800 pt-6 text-xs text-slate-500">
          <p>{t('footer.synthetic')}</p>
          <p className="mt-1">{t('footer.sprint')}</p>
        </footer>
      </div>
    </main>
  );
}
