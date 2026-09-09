import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Secretary",
  description: "A genius secretary you talk to.",
  // Home-screen install (iOS): apple-touch-icon + standalone web-app meta.
  icons: { apple: "/apple-touch-icon.png" },
  appleWebApp: {
    capable: true,
    title: "Secretary",
    statusBarStyle: "default",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Server-rendered theme attribute from the cookie — no flash. Light default.
  const theme = (await cookies()).get("theme")?.value === "dark" ? "dark" : "light";
  return (
    <html
      lang="en"
      data-theme={theme}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* suppressHydrationWarning covers ATTRIBUTES ON THIS ELEMENT ONLY, not
          its subtree. It is provably safe here because body's className is a
          static literal with no dynamic input — so any server/client attribute
          difference on <body> comes from outside React (an iOS/Safari
          extension or injected script touching the DOM before hydration),
          which is exactly the case Next's own error text calls out. A real
          mismatch in our own markup would still surface, one element deeper. */}
      <body suppressHydrationWarning className="min-h-full flex flex-col">
        {children}
      </body>
    </html>
  );
}
