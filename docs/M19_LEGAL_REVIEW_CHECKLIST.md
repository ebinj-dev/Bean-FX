# M19 — Legal Review Checklist (professional review required before launch)

Status: **REQUIRES LEGAL REVIEW** — this is a readiness checklist, not a legal opinion. No compliance certification is claimed (no GDPR/DPDP/SOC 2/ISO 27001 claims anywhere in the product).

## A. Owner must confirm before public launch (currently `REQUIRES OWNER DECISION`)

1. **Legal entity** — registered name, form of organization, registration number. *Not invented; /terms renders an explicit review marker.*
2. **Registered address / principal place of business**.
3. **Jurisdiction & governing law** for ToS/privacy (intended launch market: India? multi-region?).
4. **Contact channels** — real support email (`SUPPORT_EMAIL`/`NEXT_PUBLIC_SUPPORT_EMAIL`), grievance officer (India IT Rules, if applicable), security-reporting address.
5. **Domain name** — `PUBLIC_APP_URL` canonical/OG/sitemap base. *Not invented.*
6. **Pricing decision** — current build: free preview, payments NOT accepted. If monetizing later: payment provider, tax/GST registration, refund policy, invoice requirements.
7. **Age/eligibility policy** (minimum age) and any sector-specific content rules.
8. **Trademark/brand** clearance for "BEAN FX" in target markets.
9. **Provider account terms** — the AI/email providers configured by the operator; confirm their retention/sub-processing terms are compatible with the privacy policy text.
10. **Insurance/licensing** requirements applicable to the chosen entity/jurisdiction.

## B. Professional legal review checklist

- [ ] Privacy Policy completeness vs applicable data-protection laws (GDPR if EU exposure; India DPDP Act 2023 if India launch; CCPA if California exposure).
- [ ] Lawful basis / consent model for AI processing disclosures; AI-generated content disclosure wording.
- [ ] ToS: acceptance mechanics, eligibility, acceptable use, prohibited content, IP licenses (user retains ownership — verified the text does NOT claim BEAN FX owns user content), generated-content license grant, DMCA/copyright-complaint + repeat-infringement policy, suspension/termination, warranties, liability caps, indemnity, governing law/disputes.
- [ ] Intermediary obligations where applicable (India IT Rules 2011 + 2023 amendments: grievance redressal timelines, content takedown process) — requires the owner-confirmed entity/contact above.
- [ ] Cookie/tracking obligations — current build has ONLY the essential session cookie (documented on /cookies); re-review if analytics are ever added.
- [ ] Consumer law: refund/cancellation disclosures once billing exists; not applicable today (no payments) — verified no fake Subscribe actions.
- [ ] Cross-border transfer disclosures (AI provider locations) once final provider list is owner-confirmed.
- [ ] Retention schedules: implemented deletion vs backup cycles; policy text matches actual behavior.
- [ ] Accessibility & consumer information duties for marketing claims (all claims audited against real features).

## C. Product statements audited (no invention)

- No testimonials/user counts/awards/partnerships anywhere in public pages.
- No compliance badges/certifications displayed.
- /pricing states payments are not accepted; /about does not invent corporate history.
- /contact shows a configuration notice (not a dead address) when no support email is configured.

## D. Launch gates mapped from this checklist

1. Owner confirms items A1–A10 → fill the marked fields in `/terms` + `/privacy` + `/contact`.
2. Professional legal review signs off both policies (status flips to IMPLEMENTED).
3. Configure SMTP + support addresses (flows stop using dev-token surfaces).
4. Configure `PUBLIC_APP_URL` for canonical URLs.
5. Only then: public marketing.
