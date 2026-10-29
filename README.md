# Lumora backend

Express 5 + Prisma (PostgreSQL) REST API for the Lumora app. TypeScript, run with `tsx`.

## Run

```bash
cp .env.example .env         # then fill it in (see Environment)
npm install                  # also runs `prisma generate` for this OS
npx prisma migrate deploy    # or: npx prisma migrate dev
npm run seed                 # catalog + ingredients (run once: it isn't idempotent)
npm run seed:bounties        # bounty definitions (safe to re-run)
npm run dev                  # http://localhost:4000, GET /health to check
```

| Script | What |
| --- | --- |
| `npm start` | Run without watch mode (deployment). No build step: `tsx` runs the TypeScript |
| `npm test` | Unit tests for the rule engines and AI-output validation (`node:test`, no database or network) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run seed:demo` | Demo users and content for showing the app; replaces earlier demo data. Log in as `demo@demo.lumora.app` / `Demo@1234` |
| `npm run unseed:demo` | Remove every `@demo.lumora.app` user and everything they own. Catalog products stay |

If the server crashes with "Prisma Client could not locate the Query Engine", `node_modules` was installed on another OS: run `npx prisma generate`.

## Environment

Put these in `.env`. Everything except the database and JWT secrets is optional, and each feature degrades on its own when its key is missing.

| Variable | Used for | If missing |
| --- | --- | --- |
| `DATABASE_URL` | Prisma (read in `prisma.config.ts`) | Server won't start |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Auth tokens | Auth fails |
| `PORT` | Listen port | 4000 |
| `TZ` | Server timezone for the 8 pm streak reminder and "checked in today" | `Asia/Kolkata` for the cron; `startOfDay` uses the host timezone |
| `GOOGLE_WEB_CLIENT_ID` | Verifying Google ID tokens. Must equal the app's `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | Google sign-in fails |
| `RESEND_API_KEY`, `EMAIL_FROM` | Password-reset emails. `EMAIL_FROM` must be on a domain verified in Resend (e.g. `Lumora <hello@getlumora.site>`) | Reset code is logged to the console; without `EMAIL_FROM`, sends from `onboarding@resend.dev` (delivers only to the Resend account owner) |
| `EMAIL_REPLY_TO` | Reply-to address on those emails (e.g. the Zoho inbox `hello@getlumora.site`) | No reply-to |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET_NAME` | Image uploads | Uploads fail |
| `GEMINI_API_KEY` | Face-scan analysis and "from the web" product suggestions | Heuristic face analysis; no web suggestions |
| `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL`, `GEMINI_SEARCH_MODEL` | Model overrides (free-tier quota is per model) | Built-in defaults |
| `OPENWEATHER_API_KEY` | `GET /weather/current` | That endpoint fails; the daily brief uses Open-Meteo, which needs no key |
| `ADMIN_EMAILS` | Comma-separated emails allowed into `/admin` | Nobody is an admin |

## Routes

| Mount | What it does |
| --- | --- |
| `/auth` | signup, login, Google, token refresh, forgot/reset password |
| `/users` | me, update me, public profile, push token |
| `/skin-profile` | onboarding profile, budget |
| `/products` | catalog, barcode lookup, popular, verdict with match %, photo-scan match, AI identify (`POST /products/identify`) |
| `/user-products` | the user's shelf |
| `/reviews` | product reviews |
| `/checkins` | mood check-ins, streak, history, stats |
| `/recommendations` | daily brief, scan-based suggestions, feedback |
| `/routines`, `/routine-steps` | routines and step logging |
| `/posts` | community feed, likes, bookmarks, reports, comments |
| `/uploads` | image upload to Supabase Storage |
| `/face-scan` | selfie analysis and latest scan |
| `/bounties` | bounty list and completion |
| `/ingredients` | glossary |
| `/weather` | current weather (OpenWeather) |
| `/admin` | catalog CRUD and Open Beauty Facts lookup |

## Where the logic lives

| File | What |
| --- | --- |
| `src/lib/dailyBrief.ts` | Rule-based "Today's brief". Every tip cites the number behind it |
| `src/lib/environment.ts` | UV, AQI, humidity from Open-Meteo |
| `src/lib/productVerdict.ts`, `ingredientRules.ts` | Rule-based "Is this right for me?" |
| `src/lib/geminiVision.ts`, `faceAnalysis.ts` | Face scan: Gemini first, then the heuristic fallback |
| `src/lib/scanSuggestions.ts`, `webProductSearch.ts` | Scan suggestions from the user's shelf, the catalog, or the web |
| `src/lib/aiProductLookup.ts` | Gemini identifies a product missing from the catalog and Open Beauty Facts and finds its ingredients (cached; skipped without `GEMINI_API_KEY`) |
| `src/lib/openBeautyFacts.ts` | Admin product prefill |
| `src/lib/bounties.ts` | Completing a bounty by its stable `key` |
| `src/jobs/streakReminder.ts` | 20:00 daily cron: push reminder to users who haven't checked in |

## Known issues

- Refresh tokens are stateless JWTs: there is no server-side revocation list, so logging out doesn't invalidate a stolen refresh token before it expires (30 days).
- The heuristic face-scan ranges in `faceAnalysis.ts` were tuned before a bug (2026-10-27) made every region read whole-photo stats. They may need retuning against real selfies.
- Route handlers have no automated tests; `npm test` covers the `src/lib` rules.
