import Link from "next/link";
import type { ReactNode } from "react";

/**
 * M19 §2 — shared chrome for the PUBLIC marketing/legal website. Kept
 * visually consistent with the product: obsidian black, champagne accents.
 * The authenticated editing workspace is a separate surface (the SPA shell).
 */

const NAV = [
  { label: "Features", href: "/features" },
  { label: "Pricing", href: "/pricing" },
  { label: "FAQ", href: "/faq" },
  { label: "Help", href: "/help" },
  { label: "About", href: "/about" },
  { label: "Contact", href: "/contact" },
];

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-[#0b0b0a] text-[#e6e6e0]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-[#d4a017] focus:px-3 focus:py-1.5 focus:text-[#0b0b0a]"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-[#1c1c1a] bg-[#0b0b0a]/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2 font-bold tracking-[0.22em] text-white">
            <span className="inline-block h-5 w-5 rounded-sm bg-[#d4a017]" aria-hidden="true" />
            BEAN&nbsp;FX
          </Link>
          <nav aria-label="Primary" className="hidden items-center gap-5 md:flex">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#a8a8a0] transition-colors hover:text-[#d4a017]">
                {item.label}
              </Link>
            ))}
          </nav>
          <Link
            href="/"
            className="rounded border border-[#d4a017]/60 bg-[#d4a017]/10 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-[#d4a017] transition-colors hover:bg-[#d4a017]/20"
          >
            Open the app
          </Link>
        </div>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
      <footer className="border-t border-[#1c1c1a] bg-[#070707]">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-3">
          <div>
            <p className="font-bold tracking-[0.22em] text-white">BEAN FX</p>
            <p className="mt-2 max-w-xs text-[12px] leading-relaxed text-[#8f8f8a]">
              A browser-based professional video editing workspace with AI assistance. Process your own media.
            </p>
          </div>
          <nav aria-label="Legal" className="text-[12px]">
            <p className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.14em] text-[#8f8f8a]">Legal</p>
            <ul className="space-y-1.5">
              <li><Link href="/privacy" className="text-[#a8a8a0] hover:text-[#d4a017]">Privacy Policy</Link></li>
              <li><Link href="/terms" className="text-[#a8a8a0] hover:text-[#d4a017]">Terms of Service</Link></li>
              <li><Link href="/cookies" className="text-[#a8a8a0] hover:text-[#d4a017]">Cookie Policy</Link></li>
            </ul>
          </nav>
          <nav aria-label="Product" className="text-[12px]">
            <p className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.14em] text-[#8f8f8a]">Product</p>
            <ul className="space-y-1.5">
              <li><Link href="/features" className="text-[#a8a8a0] hover:text-[#d4a017]">Features</Link></li>
              <li><Link href="/pricing" className="text-[#a8a8a0] hover:text-[#d4a017]">Pricing</Link></li>
              <li><Link href="/faq" className="text-[#a8a8a0] hover:text-[#d4a017]">FAQ</Link></li>
              <li><Link href="/help" className="text-[#a8a8a0] hover:text-[#d4a017]">Help &amp; documentation</Link></li>
              <li><Link href="/contact" className="text-[#a8a8a0] hover:text-[#d4a017]">Contact &amp; support</Link></li>
            </ul>
          </nav>
        </div>
        <div className="border-t border-[#161616] py-4 text-center text-[11px] text-[#5c5c58]">
          © {new Date().getFullYear()} BEAN FX. Process your own media.
        </div>
      </footer>
    </div>
  );
}
