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

- **Inventory lock:** each item is a product with quantity 1 unless the seller says they have more. A sale with more on hand takes one off and leaves every listing up. Selling the last one sets quantity to 0 first, then flags every other live listing as "take this down".
- **Pricing:** worked backward from the seller's take-home floor per marketplace, covering fees, who pays shipping, and the discount buyers there usually expect ([pricing.ts](packages/core/src/pricing.ts)). Fees in [fees.ts](packages/core/src/fees.ts) are dated estimates.
- **Routing:** fixed rules pick marketplaces by category fit and whether the item can clear the floor there ([routing.ts](packages/core/src/routing.ts)).
- **Posting:** the item goes live on the seller's own Shopify store as a real, buyable listing (sell-once: inventory policy "deny"). A store checkout takes the one unit in stock; the `inventory_levels/update` webhook (and the phone page, as a backup) sees it and runs the same sale lock as a manual "Sold". No order or customer data is read. For Poshmark, Mercari, Depop, Vinted, Grailed and FB, v1 hands the seller copy-ready listings with links. eBay API posting is next.

## Models, routing and fallbacks (Vercel AI Gateway)

Two modalities in, two out: **photos → text** (item details, grades, honesty verdicts) and **photos → photos** (item outlines, AI model shots), plus text → text listings. All calls go through Vercel AI Gateway; the routing table lives in [models.ts](packages/agents/src/models.ts).

| Task | In → out | Primary | Backups | Why |
|---|---|---|---|---|
| Identify item | photos → details | Claude Opus 5.5 | Sonnet 5.5 → Opus 5 | Reading tags right sets the price; once per item |
| Grade photos | photos → scores | Claude Haiku 5.5 | Sonnet 5.5 | Simple call; ~40× cheaper than Opus, fastest |
| Write listings | text → text | Claude Sonnet 5.5 | Haiku 5.5 → Opus 5.5 | Good copy at half Opus price, faster |
| Honesty check | photos → verdict | Claude Sonnet 5.5 | Opus 5.5 | Runs per edited image; must be reliable |
| Item outline | photo → mask | Nano Banana 2.1 | Gemini 3.1 Flash Image → 2.5 Flash Image | B/W output; cheapest and fastest (~$0.03) |
| AI model photo | photos → photo | Nano Banana Pro | Nano Banana 2.1 → 3.1 Flash Image | Buyer-facing, most faithful (~$0.13) |

**When a provider fails:** each model is tried across its providers first (Claude: Anthropic → Vertex → Bedrock; Gemini: Google → Vertex), then the Gateway moves to the next model in the list (`providerOptions.gateway.models` + `order`). Backup image renders still have to pass the honesty check, so a weaker fallback can't put a misleading photo in a listing. If a step fails entirely, the item keeps the seller's own corrected photos.

**Seeing it:** every call's answering model, provider, latency and cost (from the Gateway's routing metadata) is saved on the item and shown on the phone page. The "simulate an outage" switch replaces each primary model ID with one that doesn't exist, so the Gateway really fails it and really falls back. Example: listings normally on Sonnet 5.5 (4.1 s, $0.0055); with the outage, Haiku 5.5 answered (2.6 s, $0.0002).

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
3. Set `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES` (same list as `shopify.app.toml`), `SHOPIFY_APP_URL` (the Vercel URL), `AI_GATEWAY_API_KEY`.
4. Point the app at the Vercel URL in `shopify.app.toml` (`application_url`, redirect URLs) and run `shopify app deploy` to push config, webhooks and metafield definitions.

## Judge demo

Judges only need the phone link (`/s/<key>`, from **Connect AI** in the app). They add photos, watch the item get identified, priced, written up and put on the store, then buy it on the storefront with a test card and watch the phone page flip to sold.

One-time setup on the dev store:

1. `shopify app deploy`, then open the app once in the store admin to approve the new scope (`write_publications`).
2. Turn on test payments (**Settings → Payments**: Shopify's Bogus Gateway, or Shopify Payments in test mode). If you use Shopify Payments, set `DEMO_TEST_CARD` to its test card.
3. In **Connect AI**, make two links: one for judges, one for you. On Vercel, set `DEMO_PRESENTER_KEY` to your link's key (only that link shows **Reset demo**, which archives every product in the store) and `STOREFRONT_PASSWORD` (the dev store's storefront password, shown next to the store link).

The "take these down" list only lists marketplaces the item was marked posted on, so for the full story post one item to Poshmark, Vinted and FB beforehand (or tap "I posted it").

## Before public launch

- Replace secret connection links with OAuth sign-in for the MCP endpoint (`withMcpAuth` from mcp-handler).
- Shopify App Store review: billing through the Shopify Billing API, listing assets, privacy policy.
- Check every fee in `fees.ts` against real payouts.
- eBay production API keys and OAuth per seller.

## Known risks

- Automating Poshmark, Mercari, Depop and FB breaks their terms, so v1 doesn't; the seller posts and takes down listings by hand with links we provide.
- Double sales on one-of-one items: the lock is instant, but manual delisting depends on the seller acting on the reminder.
