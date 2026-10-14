# agentic-selling

Sell the stuff you don't need anymore on every marketplace, from a chat with your AI assistant.

Take photos → your assistant (Claude, ChatGPT…) or the Shopify app identifies the item, prices it for each marketplace from your take-home floor, and writes the listings → you post → when it sells anywhere, the item locks and you get a list of what to take down.

## How it fits together

```
 Shopify mobile app ──► photos as a draft product (the seller's private store)
                              │
        ┌─────────────────────┴─────────────────────┐
        ▼                                           ▼
 Claude / ChatGPT ── MCP (/mcp?key=…) ──►    Shopify admin app (embedded)
 (the assistant sees, asks, writes)          ("Write listings with AI" via Vercel AI Gateway)
        │                                           │
        └──────────────► shared selling logic ◄─────┘
                         pricing · routing · listing rules · sale lock
                                     │
                              InventoryStore
                         (Shopify now; hosted DB later for sellers without Shopify)
```

- **Inventory lock:** each item is a product with quantity 1. Marking it sold sets quantity to 0 first, then flags every other live listing as "take this down".
- **Pricing:** worked backward from the seller's take-home floor per marketplace, covering fees, who pays shipping, and the discount buyers there usually expect ([pricing.ts](packages/core/src/pricing.ts)). Fees in [fees.ts](packages/core/src/fees.ts) are dated estimates.
- **Routing:** fixed rules pick marketplaces by category fit and whether the item can clear the floor there ([routing.ts](packages/core/src/routing.ts)).
- **Posting:** v1 hands the seller copy-ready listings with links for Poshmark, Mercari, Depop, Vinted, Grailed and FB. eBay API posting is next.

## Layout

| Path | What |
|---|---|
| `packages/core` | Channel profiles, fees, pricing, routing, inventory interface, sale logic. No dependencies; tested. |
| `packages/agents` | Server-side Claude calls: identify item from photos, write listings. Uses Vercel AI Gateway when `AI_GATEWAY_API_KEY` is set. |
| `apps/shopify` | Public Shopify app (React Router, Polaris, Prisma/Postgres) hosted on Vercel. Admin screens + the MCP endpoint. |

## Run locally

Needs Node 24+, the [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) (`npm i -g @shopify/cli`), a Shopify Partner account with a development store, and Postgres.

```bash
npm install
npm test                              # core logic tests
createdb agentic_selling              # or use a Neon database
cd apps/shopify
echo 'DATABASE_URL=postgresql://localhost:5432/agentic_selling' > .env
npm run dev                           # shopify app dev: links the app, opens a tunnel, installs on your dev store
```

To try the assistant flow: in the app, open **Connect AI**, create a link, and add it as a custom connector in Claude (Settings → Connectors) or ChatGPT (Developer mode).

CLI-only intake (no Shopify): `npm run intake -- --floor 40 photos/*.jpg` from the repo root.

## Deploy (Vercel)

1. Import the repo in Vercel, root directory `apps/shopify` (framework: React Router; build command `npm run vercel-build`).
2. Add a Neon Postgres database from the Vercel Marketplace (sets `DATABASE_URL`).
3. Set `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES`, `SHOPIFY_APP_URL` (the Vercel URL), `AI_GATEWAY_API_KEY`.
4. Point the app at the Vercel URL in `shopify.app.toml` (`application_url`, redirect URLs) and run `shopify app deploy` to push config, webhooks and metafield definitions.

## Before public launch

- Replace secret connection links with OAuth sign-in for the MCP endpoint (`withMcpAuth` from mcp-handler).
- Shopify App Store review: billing through the Shopify Billing API, listing assets, privacy policy.
- Check every fee in `fees.ts` against real payouts.
- eBay production API keys and OAuth per seller.

## Known risks

- Automating Poshmark, Mercari, Depop and FB breaks their terms, so v1 doesn't; the seller posts and takes down listings by hand with links we provide.
- Double sales on one-of-one items: the lock is instant, but manual delisting depends on the seller acting on the reminder.
