import type { Metadata } from "next";
import "./globals.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "Annotagent",
  description: "AI-powered research paper annotation and inquiry tool."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
