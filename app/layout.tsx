import "./globals.css";
import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";

const gothamPro = localFont({
  src: [
    {
      path: "../assets/fonts/gothampro/gothampro_light.ttf",
      weight: "300",
      style: "normal"
    },
    {
      path: "../assets/fonts/gothampro/gothampro_lightitalic.ttf",
      weight: "300",
      style: "italic"
    },
    {
      path: "../assets/fonts/gothampro/gothampro.ttf",
      weight: "400",
      style: "normal"
    },
    {
      path: "../assets/fonts/gothampro/gothampro_italic.ttf",
      weight: "400",
      style: "italic"
    },
    {
      path: "../assets/fonts/gothampro/gothampro_medium.ttf",
      weight: "500",
      style: "normal"
    },
    {
      path: "../assets/fonts/gothampro/gothampro_mediumitalic.ttf",
      weight: "500",
      style: "italic"
    },
    {
      path: "../assets/fonts/gothampro/gothampro_bold.ttf",
      weight: "700",
      style: "normal"
    },
    {
      path: "../assets/fonts/gothampro/gothampro_bolditalic.ttf",
      weight: "700",
      style: "italic"
    },
    {
      path: "../assets/fonts/gothampro/gothampro_black.ttf",
      weight: "900",
      style: "normal"
    },
    {
      path: "../assets/fonts/gothampro/gothampro_blackitalic.ttf",
      weight: "900",
      style: "italic"
    }
  ],
  variable: "--font-gotham-pro",
  display: "swap"
});

export const metadata: Metadata = {
  title: "Cherkizovo Design Service",
  description: "Template render service"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body className={`${gothamPro.className} ${gothamPro.variable}`}>{children}</body>
    </html>
  );
}
