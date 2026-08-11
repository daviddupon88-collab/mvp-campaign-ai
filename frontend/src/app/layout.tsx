export const metadata = {
  title: 'Campaign-ai',
  description: 'Générez des campagnes marketing complètes avec l\'IA',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, background: '#f7f7f5' }}>
        {children}
      </body>
    </html>
  );
}
