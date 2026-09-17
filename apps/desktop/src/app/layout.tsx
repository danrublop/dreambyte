import type { Metadata } from 'next'
import { GeistSans } from 'geist/font/sans'
import { DM_Mono, Caveat } from 'next/font/google'
import { Providers } from '@/components/Providers'
import './globals.css'
import '@/lib/fonts/imports'

const dmMono = DM_Mono({
  subsets: ['latin'],
  weight: ['300', '400', '500'],
  variable: '--font-dm-mono',
})

const caveat = Caveat({
  subsets: ['latin'],
  variable: '--font-caveat',
})

export const metadata: Metadata = {
  title: 'Dreambyte',
  description: 'Create and edit animated videos',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${dmMono.variable} ${caveat.variable}`}>
      <head>
        <link href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,600,700&display=swap" rel="stylesheet" />
        <link href="https://fonts.googleapis.com/css2?family=Saira+Stencil+One&display=swap" rel="stylesheet" />
      </head>
      <body className="font-sans antialiased overflow-hidden" suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
