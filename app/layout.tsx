import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Orbitry — 3D Asset Preview',
  description: 'A browser-based 3D asset previewer for Blender, glTF, and OBJ files.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
