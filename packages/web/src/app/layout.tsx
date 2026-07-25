import type { Metadata } from 'next';
import '@fontsource/maple-mono/400.css';
import '@fontsource/maple-mono/400-italic.css';
import '@fontsource/maple-mono/700.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Riddle Playground',
  description: 'An in-browser playground for the Riddle programming language',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
