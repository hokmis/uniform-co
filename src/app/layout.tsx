import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "制服管理系統",
  description: "人資、倉庫與採購共用的制服發放管理基礎",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant" data-appearance="current">
      <body>{children}</body>
    </html>
  );
}
