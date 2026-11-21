# M31 FEATURE MATRIX (capability × validation dimension)

| Capability | Implemented | Automated | Real-host | External config | Operational |
|---|---|---|---|---|---|
| Editing core (timeline/undo/markers/roll/keyframes) | VERIFIED | VERIFIED (batch 36/36) | n/a | none | yes |
| Audio (gain/pan/xfade/GANGZII) | VERIFIED | VERIFIED (m17 suites) | n/a | none | yes |
| Media ingest/probe/proxy/relink | VERIFIED | VERIFIED (m31-media-qual + batch) | n/a | none | yes |
| Export conformance | VERIFIED | VERIFIED (ffprobe full validation) | n/a | none | yes |
| Packaging/import/integrity | VERIFIED | VERIFIED (m29 8/8+4/4) | n/a | none | yes |
| Collaboration (roles/invites/links/guests) | VERIFIED | VERIFIED (m30 28 + m31 7) | n/a | none | yes |
| Worker durability | VERIFIED | VERIFIED (m31 fault injection 7) | n/a | none | yes |
| Backup/restore | VERIFIED (DB+store copy drill) | VERIFIED (11/11) | n/a | object-store = INFRA REQUIRED | partial |
| Observability | VERIFIED (admin/health extension) | tsc-verified | n/a | none | yes |
| Bounded performance | VERIFIED (measured, bounded) | VERIFIED (5/6 + documented S1) | n/a | none | yes |
| M13 temporal CSRT | VERIFIED | **VERIFIED 17/17** (contrib pinned) | n/a | none | yes |
| Premiere UXP real host | VERIFIED (code) | AUTOMATED (static+protocol suites) | **OWNER ACTION** | none | checklist ready |
| Desktop Bridge on Windows | VERIFIED (code) | AUTOMATED | **OWNER ACTION** | none | checklist ready |
| AI providers (6 engines) | VERIFIED (contracts) | AUTOMATED | n/a | **CONFIGURATION REQUIRED** | diagnostics ready |
| Email delivery | VERIFIED (honest contract) | AUTOMATED | n/a | **CONFIGURATION REQUIRED** | fallback VERIFIED |
| Object-store backup | NOT IMPLEMENTED | — | — | **INFRASTRUCTURE REQUIRED** | — |
| Payments / public launch | NOT IMPLEMENTED (deliberate) | — | — | — | — |

Every Automated claim cites a log in `download/m31-evidence/`. No dimension collapsed into a misleading green.
