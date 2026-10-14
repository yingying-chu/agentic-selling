# agentic-selling

Photos in → listings out → posted everywhere it'll sell → delisted everywhere when it sells.
Shopify is the inventory source of truth. Single-seller tool for now; apparel first.

## How it fits together

```
 Photos ──► Intake agent ──► Shopify (draft product + per-channel metafields)
              │                      ▲          │
              ▼                      │          ▼
        Pricing (floor-based)   Sync service ◄── webhooks (Shopify, eBay)
              │                      ▲      ◄── Gmail watch (Poshmark/Mercari/Depop/Vinted sale emails)
              ▼                      │      ◄── periodic reconcile via extension
        Routing ──► Channel adapters
                     ├─ API: eBay, Etsy, Shopify
                     └─ Chrome extension (your own logged-in browser): Poshmark, Mercari, Depop, Vinted, Grailed, FB
```

- **Inventory lock:** every unique item is a Shopify product with quantity 1. A sale anywhere sets it to 0; going to 0 triggers delisting everywhere else.
- **Pricing:** worked backward from your take-home floor per channel: fees, who pays shipping, and the offer discount buyers expect on that platform ([pricing.ts](packages/core/src/pricing.ts)). Fees live in [fees.ts](packages/core/src/fees.ts) with a review date and confidence. They're estimates until checked against real payouts.
- **Routing:** the model describes the item; deterministic code picks channels by category fit and whether the price can clear your floor there ([routing.ts](packages/core/src/routing.ts)).

## Layout

| Path | What |
|---|---|
| `packages/core` | Channel profiles, fee schedules, pricing engine, routing. No dependencies, fully tested. |
| `packages/agents` | Claude-powered intake: identify item from photos, write per-channel listings. |

## Try it

Requires Node 24+ (runs TypeScript directly, no build step).

```bash
npm install
cp .env.example .env   # add ANTHROPIC_API_KEY
npm test
npm run intake -- --floor 40 --notes "worn twice, size tag cut" photos/dress-*.jpg
```

Output: a table of list price / minimum acceptable offer / take-home per channel, which channels it picked and why, and full drafts in `out/*.json`. Nothing is posted.

## Roadmap

1. **Intake** ✅ photos → facts, prices, routes, drafts.
   Next: photo cleanup (background removal, hero shot), write drafts into Shopify as draft products.
2. **eBay over API**: post, receive order notifications, decrement Shopify. Real sold comps feed pricing.
3. **Chrome extension**: Poshmark + Mercari first. Gmail sale-email watcher. Automatic delisting.
4. **Agents that manage listings over time**: repricing stale items, handling offers, adding channels.

## Known risks

- Automating Poshmark, Mercari, Depop and FB breaks their terms. Keep it human-paced, in your own browser, and approve posts yourself.
- Double sales on one-of-one items: delisting speed is what counts. Limit high-value items to fewer channels.
