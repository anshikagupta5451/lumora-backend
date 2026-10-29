# AGENTS.md

Instructions for AI coding agents working in the Lumora backend. Humans: see [README.md](README.md). Cross-project rules, including how this API pairs with the app, are in [../AGENTS.md](../AGENTS.md).

## 1. Stack

**Express 5 + Prisma 6 + PostgreSQL (Neon)**, TypeScript run directly with `tsx` (`npm run dev`). CommonJS modules, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. There is no build step. Tests use Node's built-in `node:test` (`npm test`, files in `test/`); don't add Jest or Vitest.

- Express **5**: async handlers that throw or reject are forwarded to the error handler automatically. Don't add `express-async-handler` or wrap every route in try/catch just for that.
- Prisma **6**: use `@prisma/client` through the shared instance in `src/lib/prisma.ts`. Never `new PrismaClient()` anywhere else. The `prisma-upgrade-v7` skill exists for a future upgrade. Don't upgrade as a side effect.

Prisma skills live in `.agents/skills/` (also reachable as `.claude/skills/`). Load `prisma-cli`, `prisma-client-api` or `prisma-database-setup` before non-trivial schema, query or migration work.

## 2. Layout

| Path | Holds |
| --- | --- |
| `src/index.ts` | App setup, router mounts, starts the cron job |
| `src/routes/<resource>.ts` | One `express.Router()` per resource, default export, mounted in `index.ts` |
| `src/lib/` | Business logic and external clients (rules, Gemini, Open-Meteo, Supabase, mailer) |
| `src/middleware/` | `requireAuth` (sets `req.userId`), `requireAdmin` (`ADMIN_EMAILS` allowlist) |
| `src/jobs/` | `node-cron` jobs |
| `prisma/schema.prisma`, `prisma/migrations/` | Schema and migration history |
| `prisma/seed.ts`, `prisma/seedBounties.ts` | Catalog/ingredient and bounty seeds |
| `prisma/seedDemo.ts` | Demo users/content, all owned by `@demo.lumora.app` users (`seed:demo`, `unseed:demo`) |
| `test/` | Unit tests for `src/lib` (pure functions only: no DB, no network) |

Keep route files thin. Anything with rules or scoring belongs in `src/lib/` (see `productVerdict.ts`, `dailyBrief.ts`).

## 3. Conventions

- **Errors**: `return res.status(code).json({ error: 'Human readable message' })`. The app shows `error` directly in a toast, so write it for users. Always `{ error }`, never `{ message }` or a bare string.
- **Auth**: protect routes with `requireAuth` and read the user from `req.userId!`. Admin routes use `requireAdmin`. Never trust a `userId` from the body or query.
- **Ownership**: on update or delete, scope the query to `req.userId` (for example `where: { id, userId: req.userId! }`) so users can't touch each other's rows.
- **Selects**: when including `user`, select only public fields (`id`, `name`). Never return `passwordHash`, reset codes or push tokens.
- **Bounties**: award with `awardBounty(userId, key)` from `src/lib/bounties.ts` using the stable `key`. Don't write to bounty tables directly.
- **Env**: read `process.env.X` where it is used, and degrade gracefully when an optional key is missing (see the table in the README). Add every new variable to that table.
- **Style**: match the file you're in. Quote style and semicolons vary between files. Don't reformat files you aren't otherwise changing.

## 4. AI features

Gemini is used only in `src/lib/geminiVision.ts` (face scan), `src/lib/webProductSearch.ts` (web suggestions) and `src/lib/aiProductLookup.ts` (name and ingredients of a product missing from the catalog and Open Beauty Facts; the verdict on it stays rule-based).

- Prefer rules. Don't add a new model call unless the task asks for one.
- Every model call needs a non-AI fallback, or must hide the feature, when `GEMINI_API_KEY` is missing or the quota is spent. `faceAnalysis.ts` is the reference fallback.
- Model names come from `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL` and `GEMINI_SEARCH_MODEL`, with defaults in code. Don't hardcode a model at the call site.
- Parse and validate model JSON before using it, and clamp scores to their expected ranges.

## 5. Database and migrations

`DATABASE_URL` points at a **hosted Neon database with real data**.

- Schema change → edit `schema.prisma` → `npx prisma migrate dev --name <snake_case_change>` → commit the schema and the new migration folder together.
- Never edit or delete a migration that has already been applied. Add a new one.
- **Never** run `prisma migrate reset`, `prisma db push --force-reset`, `DROP`/`TRUNCATE`, or a seed against the hosted DB without explicit permission.
- Adding a required column to a table with rows needs a default or a backfill in the same migration.

## 6. Do not

- Edit `.env` or print its values.
- Add a dependency, framework, validation library or ORM pattern unless asked.
- Change a response shape without updating `../lumora-app/src/api/<resource>.ts` in the same task (or say clearly that you didn't).

## 7. Before finishing

```bash
npx tsc --noEmit   # must be clean
npm test           # must pass; add a test when you change a rule in src/lib
```

If you changed a route, say which endpoints and whether you exercised them (for example with `curl` against `npm run dev`). Report what you verified and what you didn't.
