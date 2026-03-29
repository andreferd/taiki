import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geist = Geist({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Is Taiki Bullish or Bearish?",
  description:
    "Real-time sentiment analysis of Taiki Maeda's (@TaikiMaeda2) latest posts on X.",
  openGraph: {
    title: "Is Taiki Bullish or Bearish?",
    description: "Live market sentiment from Taiki Maeda's X posts.",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={geist.className}>
      <body className="min-h-screen bg-black text-white">{children}</body>
    </html>
  );
}
