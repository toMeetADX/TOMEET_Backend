import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TOMEET 测试台",
  description: "TOMEET 前后端分离测试客户端"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
