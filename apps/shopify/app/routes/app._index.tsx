import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { CHANNELS } from "@agentic-selling/core";
import { authenticate } from "../shopify.server";
import { ShopifyInventoryStore } from "../inventory/shopify-store.server";
import { money, STAGE_LABEL } from "../ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const store = new ShopifyInventoryStore(admin.graphql, session.shop);
  const { items } = await store.listItems({ limit: 50 });
  return {
    items: items.map((i) => ({
      id: i.id.split("/").pop()!,
      title: i.facts?.title ?? i.title,
      thumb: i.photos[0]?.url ?? null,
      stage: i.stage,
      floor: i.floorNet,
      live: i.channels.filter((c) => c.status === "active").map((c) => CHANNELS[c.channel].name),
      needsDelist: i.channels.filter((c) => c.status === "needs_delist").length,
    })),
  };
};

export default function Items() {
  const { items } = useLoaderData<typeof loader>();

  if (!items.length) {
    return (
      <s-page heading="Your items">
        <s-section heading="Add your first item">
          <s-paragraph>
            Open the Shopify app on your phone, go to Products → Add product, take a few photos (front, back, tags,
            any flaws) and save. You don't need to fill in anything else.
          </s-paragraph>
          <s-paragraph>
            Then come back here, or ask your AI assistant to "list my new stuff" once it's connected on the{" "}
            <s-link href="/app/connect">Connect AI</s-link> page.
          </s-paragraph>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Your items">
      <s-section padding="none">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Item</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header format="currency">Floor</s-table-header>
            <s-table-header>Live on</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {items.map((i) => (
              <s-table-row key={i.id}>
                <s-table-cell>
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-thumbnail src={i.thumb ?? undefined} alt={i.title} size="small" />
                    <s-link href={`/app/items/${i.id}`}>{i.title}</s-link>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  {i.needsDelist ? (
                    <s-badge tone="critical">Take down {i.needsDelist} listing{i.needsDelist > 1 ? "s" : ""}</s-badge>
                  ) : (
                    <s-badge tone={STAGE_LABEL[i.stage].tone}>{STAGE_LABEL[i.stage].label}</s-badge>
                  )}
                </s-table-cell>
                <s-table-cell>{money(i.floor)}</s-table-cell>
                <s-table-cell>{i.live.join(", ") || "—"}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
