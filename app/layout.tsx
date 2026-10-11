import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./lemonade.css";

export const metadata: Metadata = {
  title: "Свинтус — подложи свинью товарищу",
  description:
    "Онлайн-карточная игра для 2–6 участников: друзья и боты. Раздай карты и первым избавься от всей руки.",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-visual",
  themeColor: "#075769",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
