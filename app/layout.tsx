import type { Metadata } from "next";
import "./globals.css";
import "katex/dist/katex.min.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { Providers } from "@/components/providers";
// import { PasswordGate } from "@/components/password-gate";

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
        <Providers>
          {/* <PasswordGate>{children}</PasswordGate> */}
          {children}
        </Providers>
      </body>
    </html>
  );
}
