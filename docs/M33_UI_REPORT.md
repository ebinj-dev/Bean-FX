# M33 — UI REPORT (Track F)

**Status: M33 changed NO UI files** (`showcase-studio.tsx` untouched). The M32 UI evidence (desktop + 375px walkthrough, zero horizontal overflow, honest states) remains the current UI evidence and is unaffected by the M33 changes (provider readiness, campaign variants, masks panels all render the same data plus now-restorable mask rows).

**Browser walkthrough this session: NOT RUN** (session cutoff during final verification; the prior session's screenshots are preserved in `download/m32/evidence/`). Required follow-up: re-capture desktop + 375px after the Track D re-run (variant COMPLETED states + mask rows will now show live data).

## UX guarantees (unchanged, by construction)

- No fake progress / no false success: variant statuses come from real job reconciliation (`syncVariantRenders`); FAILED variants render with their precise error.
- No hidden failed variants; no silent asset substitution (mask import restores honest FAILED rows).
- No unnecessary paid provider requests; no horizontal overflow at 375px (verified in M32; no layout-affecting changes since).
