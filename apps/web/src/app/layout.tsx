import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Morrow — Thoughtful finds, from trusted stores",
  description:
    "A curated marketplace for discovering products from independent stores.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
