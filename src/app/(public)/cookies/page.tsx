import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Cookie Policy — BEAN FX",
  description: "BEAN FX uses exactly one essential session cookie. No analytics, advertising or third-party tracking cookies exist.",
  alternates: { canonical: "/cookies" },
};

export default function CookiesPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#d4a017]">Cookies</p>
      <h1 className="mt-2 text-3xl font-bold text-white sm:text-4xl">Cookie Policy</h1>
      <p className="mt-4 rounded-lg border border-red-500/40 bg-red-500/5 p-4 text-[13.5px] leading-relaxed text-[#c9c9c2]">
        <strong className="text-red-400">REQUIRES LEGAL REVIEW:</strong> this document describes
        verified application behavior and is not legal advice. It must be reviewed and approved by a
        qualified legal professional before public commercial launch, together with the owner fields
        marked <em>[OWNER TO CONFIRM]</em> in the launch checklist.
      </p>
      <p className="mt-4 text-[14.5px] leading-relaxed text-[#b8b8b0]">
        BEAN FX sets exactly one cookie:
      </p>
      <div className="mt-6 overflow-x-auto rounded-lg border border-[#1c1c1a]">
        <table className="w-full text-left text-[13px]">
          <thead className="bg-[#101010] text-[#8f8f8a]">
            <tr>
              <th className="px-4 py-2 font-bold">Name</th><th className="px-4 py-2 font-bold">Purpose</th><th className="px-4 py-2 font-bold">Category</th><th className="px-4 py-2 font-bold">Attributes</th>
            </tr>
          </thead>
          <tbody className="text-[#b8b8b0]">
            <tr className="border-t border-[#1c1c1a]">
              <td className="px-4 py-2 font-mono text-[12px] text-white">beanfx_session</td>
              <td className="px-4 py-2">Keeps you signed in. It is your authentication.</td>
              <td className="px-4 py-2">Essential</td>
              <td className="px-4 py-2">httpOnly, Secure, SameSite=None;Partitioned, Path=/</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2 className="mt-8 text-xl font-bold text-white">No consent banner, on purpose</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        There are no analytics, preference, advertising or third-party cookies, so there is nothing to opt into or
        out of. If optional tracking is ever added, a consent manager with accept/reject/manage options will be
        introduced first, and this page will list every cookie. We show no fake consent controls.
      </p>
      <h2 className="mt-8 text-xl font-bold text-white">Browser storage</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        The editing workspace keeps UI preferences in your browser&apos;s local storage (for example timeline zoom).
        No credentials or tokens are stored there — the session lives exclusively in the httpOnly cookie above.
      </p>
    </div>
  );
}
