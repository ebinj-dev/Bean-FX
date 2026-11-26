import Link from "next/link";

/**
 * M47.1 §E — shared DRAFT banner for every legal document.
 * These documents describe verified application behavior and are internal
 * drafts: no registered company name, address, legal contact email, grievance
 * officer, retention periods, jurisdiction or payment terms are INVENTED.
 * Owner-specific fields are marked [OWNER TO CONFIRM] and the documents must
 * not be presented as final binding policies until a qualified professional
 * has reviewed and the owner has approved them.
 */
export function LegalDraftBanner({ document, updated }: { document: string; updated: string }) {
  return (
    <>
      <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/5 p-4 text-[13.5px] leading-relaxed text-[#c9c9c2]">
        <strong className="text-red-400">DRAFT — REQUIRES LEGAL REVIEW:</strong> this {document} describes verified
        application behavior and is not legal advice. It must be reviewed and approved by a qualified legal
        professional before it is treated as a binding policy. Owner-specific fields are marked{" "}
        <em>[OWNER TO CONFIRM]</em> and must be completed before publication as final terms.
      </div>
      <p className="mt-3 text-[12.5px] text-[#8f8f8a]">
        Draft updated {updated}. Policy versioning and per-account acceptance tracking will be implemented only after
        the actual final terms are approved — nothing here claims compliance today. Part of the{" "}
        <Link href="/legal" className="text-[#d4a017] hover:underline">Legal &amp; Trust Center</Link>.
      </p>
    </>
  );
}
