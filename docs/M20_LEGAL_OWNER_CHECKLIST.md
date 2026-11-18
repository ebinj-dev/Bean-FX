# M20 §8 — Legal & Business Launch Checklist (OWNER ACTION REQUIRED)

Status: **OWNER ACTION REQUIRED** — every item below needs a real decision or document from the owner. Nothing is invented; policy drafts render explicit review markers until these are supplied.

## A. Owner decisions (blocking public launch)

| # | Item | Why it blocks | Where it surfaces |
|---|---|---|---|
| A1 | Legal entity name + registration (CIN if India) | Contracts, policies, invoices | /terms, /privacy, invoicing |
| A2 | Business registration status (registered? pending?) | Legal capacity to contract | /terms |
| A3 | Jurisdiction & governing law | ToS disputes, data-protection regime | /terms |
| A4 | Public business address (if legally required in chosen jurisdiction) | Consumer/intermediary rules | /terms, /contact |
| A5 | Support email (real mailbox) | Contact page renders a config notice until set | `SUPPORT_EMAIL`, `NEXT_PUBLIC_SUPPORT_EMAIL` |
| A6 | Grievance officer contact (India — DPDP/IT Rules where applicable) | Statutory contact point | /privacy, /contact |
| A7 | Production domain | Canonical/OG/sitemap/cookie scope | `PUBLIC_APP_URL` |
| A8 | Data retention decisions (deferred-cleanup schedule, backup retention) | Policy must match behavior | /privacy |
| A9 | External AI provider disclosures (final provider list + their retention terms) | Privacy policy accuracy | /privacy |
| A10 | Refund/cancellation terms (only if payments ever launch) | Consumer law | /terms — payments currently DISABLED |

## B. India DPDP Act 2023 — authoritative facts verified for this checklist

Source: MeitY official text, `https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf` (opened 2026-11-16); cross-checked against the Act's public summary.

- **Phased commencement**: committee provisions from 13 Nov 2025; further obligations from **13 Nov 2026**; remainder 13 May 2027 — the compliance deadline for a launch in 2026 is real and near.
- **Data Principal rights** (s.6 ff.): access, correction, erasure, consent withdrawal, grievance redressal. BEAN FX implements access/export (`/api/account/export-data`), correction (display name), erasure (account deletion with lockout + deferred cleanup) and grievance via support contact — mapping documented in `M19_PRIVACY_DATA_MAP.md`.
- **Breach notification**: the Act requires notifying the Data Protection Board and affected Data Principals. Draft/2025 rules specify tighter timelines (widely reported as 72 h) — **the exact operational timeline must be confirmed against the official Rules text (MeitY) by the legal reviewer before launch; not asserted here.**
- **Notice/consent**: itemized notice; consent must be free, specific, informed, unconditional, unambiguous with clear affirmative action; notices must be **available in all 22 Eighth-Schedule languages** for a general launch — BEAN FX currently provides an English policy; language coverage is an owner/legal decision (launch-market dependent).
- **Children**: verifiable parental consent required for under-18s; behavioral tracking/targeted ads prohibited for children — BEAN FX has no age gate today → **needs an eligibility/age clause and possibly an age attestation; legal decision.**
- **Penalties**: schedule includes up to INR 50 crore for failure of security safeguards — makes the security program in this milestone directly relevant.

**Legal questions requiring professional advice (explicit):**
1. Whether BEAN FX is a "Data Fiduciary" (it is, for account data) and whether any processing qualifies as "significant Data Fiduciary" (would add DPO + audit duties).
2. Exact Rules-based timelines (breach notice, rights response, retention caps) from the notified Rules text.
3. Cross-border transfer position for the configured AI provider(s).
4. Intermediary/IT Rules duties for user-generated video content (takedown timelines, grievance machinery).
5. 22-language notice coverage scope and mechanics.
6. Whether the free-preview state (no payments) changes consumer-law duties at launch.

## C. Policy drafts (accurate to verified behavior)

- `/privacy` — data map-accurate draft (M19), effective date placeholder **REQUIRES LEGAL REVIEW**.
- `/terms` — acceptance, eligibility, IP (user retains ownership), generated content, UGC rules, liability — **REQUIRES LEGAL REVIEW**.
- `/cookies` — matches reality: one essential session cookie, no tracking — **REQUIRES LEGAL REVIEW** (formality).
- No compliance badges (DPDP/GDPR/SOC 2/ISO) are claimed anywhere in the product.

## D. Payments (§9 audit)

No payment infrastructure exists in the codebase (no provider SDK, no checkout routes, no billing models). Purchases are NOT displayed (pricing page states payments are not accepted). Future integration requirements documented in `M20_RELEASE_NOTES.md` and the pricing page's honest status. **No live payment processing exists or is activated.**

## E. CERT-In Directions 2022 — verified facts (India, if launched into India)

Source: CERT-In Directions under s.70B(6) IT Act, No. 20(3)/2022-CERT-In, dated 28 April 2022 (`https://www.cert-in.org.in/`, opened 2026-11-17); requirements cross-checked against public compliance summaries (2026).

- **6-hour incident reporting**: specified cyber incidents (20 types, Annexure I — including unauthorized access, data breaches, ransomware) must be reported to CERT-In within **6 hours of noticing**. The incident-response procedure in `M20_RELEASE_RUNBOOK.md` must include this reporting lane for an India launch.
- **180-day log retention**: logs of all ICT systems must be maintained for a rolling **180 days** within India. BEAN FX currently retains application/audit logs without a 180-day India-resident retention guarantee — **owner/legal decision required before India launch** (log retention policy + hosting location).
- **Time sync**: systems must sync to NPL/NIC time sources — operational decision if hosting in India.
- **Named point of contact**: a designated PoC must be reachable for incident coordination — folds into checklist items A5/A6 (support email / grievance officer).

**Legal questions added (require professional advice):** whether CERT-In Directions apply at launch scale and hosting jurisdiction; whether the current log pipeline (application + audit events, no network-flow logging) meets the Directions' scope or needs extension. DPDP Rules reference for §B: notified as G.S.R. 843(E), 13 November 2025 — phased obligations through 13 May 2027 (verified against practitioner analyses, 2026).
