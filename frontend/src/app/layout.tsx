import { Inter, Space_Grotesk, JetBrains_Mono, Noto_Sans_Arabic } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { isRtl } from '@/i18n/config';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-space-grotesk' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono' });
// Chargée en plus des polices latines existantes, jamais à leur place — appliquée
// uniquement sous [dir="rtl"] (cf. globals.css), donc sans effet sur en/de/fr.
const notoSansArabic = Noto_Sans_Arabic({ subsets: ['arabic'], variable: '--font-arabic' });

export const metadata = {
  title: 'Campaign-ai',
  description: 'Generate complete marketing campaigns with AI',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  const dir = isRtl(locale) ? 'rtl' : 'ltr';

  return (
    <html
      lang={locale}
      dir={dir}
      className={`${inter.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable} ${notoSansArabic.variable}`}
    >
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
