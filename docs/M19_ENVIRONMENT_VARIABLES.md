# M19 — Environment Variables

Status: **IMPLEMENTED AND DOCUMENTED** — startup validation via `src/lib/env.ts` where required; placeholders in `.env.example` (no real secrets).

## Inventory (audited from `process.env.*` usages, 35 distinct names)

### Core (required)
| Var | Server-only | Purpose |
|---|---|---|
| `DATABASE_URL` | ✓ | Postgres (prod) / SQLite (dev) connection string |
| `PORT` / `HOSTNAME` / `BIND_HOST` | ✓ | standalone server bind |
| `NODE_ENV` | ✓ | production enables Secure cookies + prod headers |

### Public (safe to expose)
| Var | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPPORT_EMAIL` | support address shown on /contact (intentionally public) |
| `PUBLIC_APP_URL` | canonical/OG/sitemap base URL (owner must set; no default domain invented) |

### Email (optional — honest no-SMTP surface when unset)
| Var | Server-only | Purpose |
|---|---|---|
| `SMTP_URL` | ✓ | SMTP transport for verification/reset emails |
| `MAIL_FROM` | ✓ | From address |
| `SUPPORT_EMAIL` | ✓ | server-side support address |

### AI providers (all server-only; never in bundles)
| Var | Purpose |
|---|---|
| `BEANFX_ZAI_BIN` | z-ai CLI path used for provider calls |
| `BEANFX_MYAI_PROVIDER` / `BEANFX_MYAI_MODEL` / `BEANFX_MYAI_TIMEOUT_MS` / `BEANFX_MYAI_PLANNER_TIMEOUT_MS` / `BEANFX_MYAI_MAX_STEPS` / `BEANFX_MYAI_RETRIES` / `BEANFX_MYAI_PLAN_TTL_MS` | MY AI planning config |
| `BEANFX_JAZMII_PROVIDER` / `BEANFX_JAZMII_GENERATE_TIMEOUT_MS` / `BEANFX_JAZMII_CLI_TIMEOUT_MS` / `BEANFX_JAZMII_SCENE_THRESHOLD` / `BEANFX_JAZMII_LICENSE_NOTE` / `BEANFX_JAZMII_RETENTION_NOTE` | JAZMII generation |
| `BEANFX_LAXII_PROVIDER` / `BEANFX_LAXII_CLI_TIMEOUT_MS` / `BEANFX_LAXII_LICENSE_NOTE` / `BEANFX_LAXII_RETENTION_NOTE` | LAXII scriptwriting |
| `BEANFX_VISUAL_PROVIDER` / `BEANFX_VISUAL_MODEL` | visual labeling |
| `BEANFX_STUDIO_PLANNER_TIMEOUT_MS` | Social studio planner |

### Limits & infrastructure
| Var | Purpose |
|---|---|
| `RATE_LIMIT_SCALE` | multiplies every rate limit — **MUST be 1 in production**; raised in test/dev |
| `RATE_LIMIT_REDIS_URL` | optional shared store hook for multi-instance deployments (see audit §Residual 1) |
| `USER_STORAGE_QUOTA_BYTES` | per-user upload quota |
| `BEANFX_USER_QUOTA_BYTES` | legacy alias |
| `BEANFX_MEDIA_WORKER_AUTOSTART` | auto-start in-process media worker |
| `BEANFX_MCP_CALL_TIMEOUT_MS` / `BEANFX_MCP_RATE_PER_MIN` | automation/MCP tool limits |
| `BEANFX_DATA_DIR` | data root override |
| `BEANFX_EXPORT_PROFILES_JSON` | export profile overrides |
| `BEANFX_EXPORT_*`, `BEANFX_STRIPE_*` (if present) | reserved; payments not implemented — see pricing policy |

## Rules enforced

1. Secrets never in `NEXT_PUBLIC_*` (verified: only the support email is public).
2. Fail-safe: required provider flows report honest `delivered:false` / configuration notices instead of falling back to fake providers.
3. `.env.example` documents each variable (required/optional, server-only, format) with placeholders only.
4. Production launch: set `DATABASE_URL`, `PUBLIC_APP_URL`, `SUPPORT_EMAIL`, `SMTP_URL`, provider credentials; `RATE_LIMIT_SCALE=1`.
