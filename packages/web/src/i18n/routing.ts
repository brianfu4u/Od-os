import { defineRouting } from 'next-intl/routing';

/** Trilingual routing — Chinese is the DEFAULT locale (ground rule). */
export const routing = defineRouting({
  locales: ['zh', 'en', 'ja'],
  defaultLocale: 'zh',
});

export type AppLocale = (typeof routing.locales)[number];
