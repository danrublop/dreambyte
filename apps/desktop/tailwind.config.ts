import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/components/**/*.{js,ts,jsx,tsx,mdx}', './src/app/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0d0d0f',
        panel: '#111114',
        border: '#2a2a32',
        accent: '#e84545',
        primary: '#f0ece0',
        /* shadcn/ui chart + Recharts (see src/app/globals.css --chart-*, --color-card-token) */
        background: 'var(--color-bg)',
        foreground: 'var(--color-text-primary)',
        muted: {
          DEFAULT: 'var(--color-input-bg)',
          foreground: 'var(--color-text-muted)',
        },
        card: {
          DEFAULT: 'var(--color-card-token)',
          foreground: 'var(--color-text-primary)',
        },
        chart: {
          1: 'var(--chart-1)',
          2: 'var(--chart-2)',
          3: 'var(--chart-3)',
          4: 'var(--chart-4)',
          5: 'var(--chart-5)',
        },
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'Geist', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['var(--font-dm-mono)', 'DM Mono', 'monospace'],
        caveat: ['var(--font-caveat)', 'Caveat', 'cursive'],
      },
    },
  },
  plugins: [],
}

export default config
