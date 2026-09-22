import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Geist_Mono } from "next/font/google";
import "./globals.css";

// Body text is the system face (app/globals.css --font-sans): the design is
// judged against the iPhone mockup, which is set in SF. Only the code font
// is a webfont.
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
      className={`${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
