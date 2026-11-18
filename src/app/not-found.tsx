import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#0b0b0a] px-4 text-center text-[#e6e6e0]">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#d4a017]">404</p>
      <h1 className="mt-2 text-3xl font-bold text-white">This page does not exist</h1>
      <p className="mt-3 max-w-md text-[14px] text-[#b8b8b0]">The link may be outdated. The product lives at the root of the site.</p>
      <Link href="/" className="mt-6 rounded border border-[#d4a017]/60 bg-[#d4a017]/10 px-4 py-2 text-[12px] font-bold uppercase tracking-[0.14em] text-[#d4a017] hover:bg-[#d4a017]/20">
        Go to BEAN FX
      </Link>
    </div>
  );
}
