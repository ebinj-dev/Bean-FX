import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "BEAN FX — Edit Faster. Create Better.",
  description:
    "AI-powered editing tools built for creators. Cut silence, generate captions, remove watermarks, clean audio and export professional media — all from one workspace.",
  keywords: ["BEAN FX", "video editing", "auto cut", "captions", "watermark remover", "audio cleanup", "b-roll"],
  authors: [{ name: "BEAN FX" }],
  openGraph: {
    title: "BEAN FX — Edit Faster. Create Better.",
    description: "AI-powered editing tools built for creators.",
    siteName: "BEAN FX",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#050505",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-[#050505] text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
