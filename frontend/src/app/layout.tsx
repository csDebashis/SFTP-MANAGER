import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppRouterCacheProvider } from "@mui/material-nextjs/v16-appRouter";
import ThemeProvider from "@/theme/ThemeProvider";
import UploadProvider from "@/components/UploadManager";
import "./globals.css";

export const metadata: Metadata = {
  title: "SFTP Manager",
  description: "Securely manage authorized SFTP folders and tasks",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body><AppRouterCacheProvider><ThemeProvider><UploadProvider>{children}</UploadProvider></ThemeProvider></AppRouterCacheProvider></body></html>;
}
