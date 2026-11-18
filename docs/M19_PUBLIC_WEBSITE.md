# M19 — Public Website Inventory & Content Policy

Status: **IMPLEMENTED AND TESTED** (routes, rendering, SEO, 404, sitemap/robots — `scripts/test-m19-security.test.ts` §public website, 3/3).

## Public pages (server routes under `src/app/(public)/` + root landing)

| Route | File | Purpose |
|---|---|---|
| `/` | `src/components/bean/landing.tsx` | Homepage: hero, Get Started / Sign In, product preview, features overview, AI engines, workflow, FAQ teaser, footer with legal links |
| `/features` | `(public)/features/page.tsx` | Five AI engines (RIISHE, GANGZII, NIIKI, JAZMII, LAXII), MY AI coordination, professional editor sections |
| `/pricing` | `(public)/pricing/page.tsx` | **Honest pricing status** — free preview state, no payments accepted, no fake Subscribe |
| `/about` | `(public)/about/page.tsx` | Truthful product description; no invented entity/history |
| `/contact` | `(public)/contact/page.tsx` | Support channels from `NEXT_PUBLIC_SUPPORT_EMAIL`/`SUPPORT_EMAIL`; honest "not configured" notice when absent; bug/feature/security reporting paths |
| `/faq` | `(public)/faq/page.tsx` | What it does, editor, media, AI, storage, privacy, providers, export, security, deletion, support |
| `/help` | `(public)/help/page.tsx` | Documentation entry: getting started, projects, import, timeline, audio, captions, effects, AI Studio, export, troubleshooting, privacy |
| `/privacy` | `(public)/privacy/page.tsx` | Privacy Policy (see `M19_PRIVACY_DATA_MAP.md`) |
| `/terms` | `(public)/terms/page.tsx` | Terms of Service (configurable entity/jurisdiction, review markers) |
| `/cookies` | `(public)/cookies/page.tsx` | Cookie policy: essential session cookie only; no optional tracking exists → no fake consent UI |
| `/forgot-password`, `/reset-password`, `/verify-email` | `(public)/…` | Auth flows with honest no-SMTP surfaces |
| 404 | `src/app/not-found.tsx` | Branded not-found page |
| `/settings` | `src/app/settings/page.tsx` | **Authenticated** account settings (Profile / Security / Privacy / Storage / Deletion) — excluded from sitemap & robots-allowed set |

## Content rules enforced

- No invented customers, testimonials, user counts, awards, partnerships, or performance figures.
- No invented company registration, address, or jurisdiction (marked `REQUIRES OWNER DECISION` in `/terms` and the legal checklist).
- No fake payment/subscribe actions; pricing page states payments are not accepted yet.
- No fake consent controls: the only cookie is the essential session cookie (`beanfx_session`); the cookie page documents it and does not render a pointless banner.
- Support email is environment-driven; when unset the contact page shows a configuration notice instead of a dead link.

## SEO

- `src/app/sitemap.ts` — public marketing pages only; private surfaces excluded.
- `src/app/robots.ts` (+ `public/robots.txt`) — `Disallow: /api/`, `/settings`, `/editor`, project and export routes.
- Page-specific titles/descriptions; canonical + OG/Twitter metadata in the (public) layout; favicon/icons from `public/`.
- Verified by tests: all pages 200 with content, sitemap `<loc>`, robots disallowals, branded 404.

## Documentation structure (public help)

`/help` links user-facing topics; deep technical documentation stays internal (docs/*.md) and is never published with secrets.
