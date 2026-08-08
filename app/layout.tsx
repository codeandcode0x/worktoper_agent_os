import type { Metadata, Viewport } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "WorkToper Agent OS - 桌面 Linux VM",
  description: "通过 Electron 与 QEMU 启动完整 Linux 桌面 VM，提供 APT、串口启动日志和图形应用。",
  applicationName: "WorkToper Agent OS",
  icons: { icon: "/icon.svg", apple: "/apple-icon.png" },
}

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#111317",
  width: "device-width",
  initialScale: 1,
  userScalable: true,
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" className="bg-background">
      <body className="font-sans antialiased">
        {children}
      </body>
    </html>
  )
}
