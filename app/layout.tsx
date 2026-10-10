import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Свинтус — подложи свинью товарищу',
  description: 'Онлайн-карточная игра на шесть друзей. Собери компанию, раздай карты и первым избавься от всей руки.',
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#15372e' };
export default function RootLayout({children}: Readonly<{children:React.ReactNode}>) {
  return <html lang="ru"><body>{children}</body></html>;
}
