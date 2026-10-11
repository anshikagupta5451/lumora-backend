# Lumora backend

Express 5 + Prisma (PostgreSQL) REST API for the Lumora app. TypeScript, run with `tsx`.

## Run

```bash
npm install
npx prisma migrate deploy   # or: npx prisma migrate dev
npm run seed                # catalog + ingredients
npm run seed:bounties       # bounty definitions
npm run dev                 # http://localhost:4000, GET /health to check
```

There is no `build` or `start` script yet; `npm run dev` is the only entry point.

## Environment

Put these in `.env`. Everything except the database and JWT secrets is optional, and each feature degrades on its own when its key is missing.

| Variable | Used for | If missing |
| --- | --- | --- |
| `DATABASE_URL` | Prisma (read in `prisma.config.ts`) | Server won't start |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Auth tokens | Auth fails |
| `PORT` | Listen port | 4000 |
| `GOOGLE_WEB_CLIENT_ID` | Verifying Google ID tokens. Must equal the app's `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | Google sign-in fails |
| `RESEND_API_KEY`, `EMAIL_FROM` | Password-reset emails | Reset code is logged to the console |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET_NAME` | Image uploads | Uploads fail |
| `GEMINI_API_KEY` | Face-scan analysis and "from the web" product suggestions | Heuristic face analysis; no web suggestions |
| `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL`, `GEMINI_SEARCH_MODEL` | Model overrides (free-tier quota is per model) | Built-in defaults |
| `OPENWEATHER_API_KEY` | `GET /weather/current` | That endpoint fails; the daily brief uses Open-Meteo, which needs no key |
| `ADMIN_EMAILS` | Comma-separated emails allowed into `/admin` | Nobody is an admin |

## Routes

| Mount | What it does |
| --- | --- |
| `/auth` | signup, login, Google, forgot/reset password |
| `/users` | me, update me, public profile, push token |
| `/skin-profile` | onboarding profile, budget |
| `/products` | catalog, barcode lookup, popular, verdict |
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
| `src/lib/openBeautyFacts.ts` | Admin product prefill |
| `src/lib/bounties.ts` | Completing a bounty by its stable `key` |
| `src/jobs/streakReminder.ts` | 20:00 daily cron: push reminder to users who haven't checked in |

## Known issues

- `npx tsc --noEmit` reports one error: `prisma.config.ts` passes `process.env.DATABASE_URL` (possibly `undefined`) where a `string` is required. It doesn't stop `tsx` from running.
- No tests.
