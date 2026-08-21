import type { Metadata, Viewport } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "WorkToper Agent OS - Smart Desktop",
  description: "A complete Linux desktop VM powered by Electron and QEMU, with full-screen boot output, APT, and Linux GUI applications.",
  applicationName: "WorkToper Agent OS",
  icons: { icon: "/icon.svg", apple: "/apple-icon.png" },
}

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#3b82f6",
  width: "device-width",
  initialScale: 1,
  userScalable: true,
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="bg-background">
      <body className="font-sans antialiased">
        {children}
      </body>
    </html>
  )
}
