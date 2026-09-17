import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg-primary,#0a0a0a)] p-8 text-[var(--color-text-primary,#f5f5f5)]">
      <div className="w-full max-w-md space-y-4 text-center">
        <h1 className="text-4xl font-semibold tracking-tight">404</h1>
        <p className="text-sm text-white/60">This page does not exist.</p>
        <Link
          href="/"
          className="inline-block rounded border border-white/20 bg-white/5 px-3 py-1.5 text-sm hover:bg-white/10"
        >
          Back home
        </Link>
      </div>
    </div>
  )
}
