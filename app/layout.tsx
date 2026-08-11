import type { Metadata, Viewport } from "next";

import { THEME_INIT_SCRIPT } from "./lib/theme";
import "./globals.css";

const siteUrl = new URL("https://harsh.bet/shotlab/");

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: {
    default: "ShotLab — Your basketball form, measured",
    template: "%s · ShotLab",
  },
  description:
    "Private, on-device basketball shot analysis with pose metrics, personal make/miss comparisons, and optional Firebase sync.",
  applicationName: "ShotLab",
  manifest: "manifest.webmanifest",
  alternates: {
    canonical: "https://harsh.bet/shotlab/",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "ShotLab",
  },
  icons: {
    icon: [
      { url: "icons/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "icons/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  openGraph: {
    type: "website",
    url: siteUrl,
    title: "ShotLab — Every rep leaves evidence.",
    description:
      "On-device pose analysis that learns the difference between your makes and misses.",
    images: [{ url: "og.png", width: 1200, height: 630, alt: "ShotLab basketball form analysis" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "ShotLab — Every rep leaves evidence.",
    description: "Private basketball pose analysis and your own make/miss baseline.",
    images: ["og.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eef1ee" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0e11" },
  ],
  colorScheme: "light dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // data-theme is rewritten by the inline resolver below before the first
    // paint, so the server-rendered default will not match on light setups.
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
