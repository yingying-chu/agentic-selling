import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { CHANNELS } from "@agentic-selling/core";
import { authenticate } from "../shopify.server";
import { ShopifyInventoryStore } from "../inventory/shopify-store.server";
import {
  confirmDelisted,
  getSettings,
  isChannelId,
  markPosted,
  markSold,
  planFor,
  POST_LINKS,
} from "../selling.server";
import { analyzeWithAI } from "../ai.server";
import { money, STAGE_LABEL } from "../ui";

async function context(request: Request, id: string) {
  const { admin, session } = await authenticate.admin(request);
  const store = new ShopifyInventoryStore(admin.graphql, session.shop);
  const item = await store.getItem(id);
  if (!item) throw new Response("Item not found", { status: 404 });
  return { store, item, settings: await getSettings(session.shop) };
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { item, settings } = await context(request, params.id!);
  const plan = planFor(item, settings);
  return {
    item,
    plan: "missing" in plan ? null : plan,
    missing: "missing" in plan ? plan.missing : null,
    postLinks: POST_LINKS,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { store, item, settings } = await context(request, params.id!);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const channel = String(form.get("channel") ?? "");

  try {
    switch (intent) {
      case "floor": {
        const floor = Number(form.get("floor"));
        if (!Number.isFinite(floor) || floor <= 0) return { error: "Enter an amount above $0." };
        await store.saveFloor(item.id, floor);
        return { ok: "Floor saved." };
      }
      case "analyze": {
        const notes = String(form.get("notes") ?? "").trim();
        const { drafts } = await analyzeWithAI(store, item, settings, notes || undefined);
        return { ok: drafts.length ? `Wrote ${drafts.length} listings.` : "Details saved. Add a floor price to get listings." };
      }
      case "posted":
        if (!isChannelId(channel)) break;
        await markPosted(store, item, channel, String(form.get("url") ?? "") || undefined);
        return { ok: `Marked live on ${CHANNELS[channel].name}.` };
      case "sold": {
        if (!isChannelId(channel)) break;
        const { toDelist, left } = await markSold(store, item, channel);
        if (left > 0) return { ok: `Sold one. ${left} left, so your listings stay up.` };
        return {
          ok: toDelist.length
            ? `Sold and locked. Take down: ${toDelist.map((d) => d.name).join(", ")}.`
            : "Sold and locked.",
        };
      }
      case "delisted":
        if (!isChannelId(channel)) break;
        await confirmDelisted(store, item, channel);
        return { ok: `${CHANNELS[channel].name} marked as taken down.` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Something went wrong." };
  }
  return { error: "Unknown action." };
};

export default function ItemPage() {
  const { item, plan, missing, postLinks } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const facts = item.facts;
  const toDelist = item.channels.filter((c) => c.status === "needs_delist");
  const live = item.channels.filter((c) => c.status === "active");

  return (
    <s-page heading={facts?.title ?? item.title}>
      <s-link slot="breadcrumb-actions" href="/app">
        Items
      </s-link>
      {item.adminUrl && (
        <s-button slot="secondary-actions" href={item.adminUrl} target="_blank">
          Edit in Shopify
        </s-button>
      )}

      {result && "error" in result && <s-banner tone="critical">{result.error}</s-banner>}
      {result && "ok" in result && <s-banner tone="success">{result.ok}</s-banner>}

      {toDelist.length > 0 && (
        <s-banner tone="critical" heading="Take these listings down now so nobody else buys it">
          <s-stack direction="block" gap="small">
            {toDelist.map((c) => (
              <Form method="post" key={c.channel}>
                <input type="hidden" name="intent" value="delisted" />
                <input type="hidden" name="channel" value={c.channel} />
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-text>{CHANNELS[c.channel].name}</s-text>
                  {c.url && (
                    <s-link href={c.url} target="_blank">
                      Open listing
                    </s-link>
                  )}
                  <s-button type="submit" variant="secondary">
                    Done
                  </s-button>
                </s-stack>
              </Form>
            ))}
          </s-stack>
        </s-banner>
      )}

      <s-section heading="Photos">
        <s-stack direction="inline" gap="small">
          {item.photos.map((p) => (
            <s-thumbnail key={p.url} src={p.url} alt={p.alt ?? ""} size="large" />
          ))}
          {!item.photos.length && <s-paragraph>No photos yet. Add them in Shopify.</s-paragraph>}
        </s-stack>
      </s-section>

      <s-section heading="Floor price">
        <Form method="post">
          <input type="hidden" name="intent" value="floor" />
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-number-field
              name="floor"
              label="The least you want to keep after fees and shipping"
              prefix="$"
              min={1}
              step={1}
              value={item.floorNet?.toString() ?? ""}
            />
            <s-button type="submit" {...(busy ? { loading: true } : {})}>
              Save
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading={facts ? "Details" : "Get started"}>
        {facts ? (
          <s-stack direction="block" gap="small">
            <s-paragraph>
              {[facts.brand, facts.itemType, facts.size && `size ${facts.size}`, facts.colors.join("/")]
                .filter(Boolean)
                .join(" · ")}
            </s-paragraph>
            <s-paragraph>
              Condition: {facts.condition.replaceAll("_", " ")}
              {facts.flaws.length ? ` (${facts.flaws.join("; ")})` : ""}
            </s-paragraph>
            <s-paragraph>
              Typically sells for {money(facts.estimatedSoldPriceRange.low)}–{money(facts.estimatedSoldPriceRange.high)}
            </s-paragraph>
            {facts.questionsForSeller.length > 0 && (
              <s-banner tone="warning" heading="Please check">
                <s-unordered-list>
                  {facts.questionsForSeller.map((q) => (
                    <s-list-item key={q}>{q}</s-list-item>
                  ))}
                </s-unordered-list>
              </s-banner>
            )}
          </s-stack>
        ) : (
          <s-paragraph>AI will look at your photos, read the tags, and write listings for each marketplace.</s-paragraph>
        )}
        <Form method="post">
          <input type="hidden" name="intent" value="analyze" />
          <s-stack direction="block" gap="base">
            <s-text-area
              name="notes"
              label="Anything the photos don't show? (optional)"
              placeholder="e.g. worn twice, size tag cut out but fits like a M, smoke-free home"
              rows={2}
            />
            <s-button type="submit" variant="primary" {...(busy ? { loading: true } : {})}>
              {facts ? "Redo with AI" : "Write listings with AI"}
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Where to sell and for how much">
        {plan ? (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Platform</s-table-header>
              <s-table-header format="currency">List at</s-table-header>
              <s-table-header format="currency">Accept offers from</s-table-header>
              <s-table-header format="currency">You keep</s-table-header>
              <s-table-header>Why</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {plan.routes.map((r) => {
                const p = plan.prices[r.channel];
                return (
                  <s-table-row key={r.channel}>
                    <s-table-cell>
                      {CHANNELS[r.channel].name} {r.selected && <s-badge tone="success">Recommended</s-badge>}
                    </s-table-cell>
                    <s-table-cell>{money(p?.listPrice)}</s-table-cell>
                    <s-table-cell>{money(p?.minAcceptPrice)}</s-table-cell>
                    <s-table-cell>{money(p?.expectedNet)}</s-table-cell>
                    <s-table-cell>{r.reason}</s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        ) : (
          <s-paragraph>Needs {missing} first.</s-paragraph>
        )}
      </s-section>

      {item.listings
        .filter((l) => l.channel !== "shopify")
        .map((l) => {
          const state = item.channels.find((c) => c.channel === l.channel);
          return (
            <s-section key={l.channel} heading={`${CHANNELS[l.channel].name} listing`}>
              <s-stack direction="block" gap="base">
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-badge tone={state?.status === "active" ? "success" : "neutral"}>{state?.status ?? "draft"}</s-badge>
                  <s-text>
                    List at {money(l.price.listPrice)}, accept offers from {money(l.price.minAcceptPrice)}
                  </s-text>
                </s-stack>
                {l.title && <s-text-field label="Title" value={l.title} readOnly />}
                <s-text-area label="Description" value={l.description} rows={6} readOnly />
                {l.tags.length > 0 && <s-text-field label="Tags" value={l.tags.join(" ")} readOnly />}
                <s-stack direction="inline" gap="small">
                  <s-button onClick={() => navigator.clipboard.writeText([l.title, l.description].filter(Boolean).join("\n\n"))}>
                    Copy
                  </s-button>
                  {postLinks[l.channel] && (
                    <s-button href={postLinks[l.channel]} target="_blank" variant="secondary">
                      Open {CHANNELS[l.channel].name}
                    </s-button>
                  )}
                </s-stack>
                {state?.status !== "active" && state?.status !== "sold" && item.stage !== "sold" && (
                  <Form method="post">
                    <input type="hidden" name="intent" value="posted" />
                    <input type="hidden" name="channel" value={l.channel} />
                    <s-stack direction="inline" gap="small" alignItems="end">
                      <s-url-field name="url" label="Posted? Paste the listing link (optional)" />
                      <s-button type="submit">Mark posted</s-button>
                    </s-stack>
                  </Form>
                )}
              </s-stack>
            </s-section>
          );
        })}

      {item.stage !== "sold" && live.length > 0 && (
        <s-section heading="Sold it?">
          <s-paragraph>Tell us where. We'll lock the item and list everything you need to take down.</s-paragraph>
          <s-stack direction="inline" gap="small">
            {live.map((c) => (
              <Form method="post" key={c.channel}>
                <input type="hidden" name="intent" value="sold" />
                <input type="hidden" name="channel" value={c.channel} />
                <s-button type="submit" tone="critical">
                  Sold on {CHANNELS[c.channel].name}
                </s-button>
              </Form>
            ))}
          </s-stack>
        </s-section>
      )}

      <s-section slot="aside" heading="Status">
        <s-badge tone={STAGE_LABEL[item.stage].tone}>{STAGE_LABEL[item.stage].label}</s-badge>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
