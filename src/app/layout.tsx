import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "./theme/ThemeProvider";
import { STORAGE_KEY } from "./theme/initialTheme";
import { BRAND_BASE_PATH, BRAND_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: `${BRAND_NAME} Editor — Pure TypeScript PDF Engine`,
  description:
    "A robust PDF editor built from scratch in pure TypeScript. Zero external dependencies. Professional-grade PDF capabilities.",
  icons: {
    icon: [
      { url: `${BRAND_BASE_PATH}/brand/paperloom-icon.svg`, type: "image/svg+xml", sizes: "any" },
    ],
    shortcut: `${BRAND_BASE_PATH}/brand/paperloom-icon.svg`,
    apple: { url: `${BRAND_BASE_PATH}/apple-icon.png`, sizes: "180x180", type: "image/png" },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="light" style={{ colorScheme: "light" }} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var theme=localStorage.getItem(${JSON.stringify(STORAGE_KEY)});theme=theme==="dark"?"dark":"light";document.documentElement.setAttribute("data-theme",theme);document.documentElement.style.colorScheme=theme}catch{}`,
          }}
        />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
