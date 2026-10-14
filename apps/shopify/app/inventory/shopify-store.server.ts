import { randomUUID } from "node:crypto";
import {
  stageOf,
  type ChannelListingState,
  type InventoryItem,
  type InventoryStore,
  type ItemFacts,
  type ListingDraft,
  type ListItemsOptions,
} from "@agentic-selling/core";

// InventoryStore backed by Shopify: each item is a product, selling data
// lives in app-owned metafields ($app namespace, declared in
// shopify.app.toml), and quantity 0 is the lock that prevents a double sale.

/** The `admin.graphql` function from authenticate.admin / unauthenticated.admin. */
export type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

const NS = "$app";

const PRODUCT_FIELDS = `#graphql
  fragment ItemFields on Product {
    id
    title
    createdAt
    updatedAt
    media(first: 12) {
      nodes {
        ... on MediaImage {
          image {
            url(transform: { maxWidth: 1024, maxHeight: 1024 })
            altText
          }
        }
      }
    }
    variants(first: 1) {
      nodes {
        inventoryQuantity
        inventoryItem { tracked }
      }
    }
    floorNet: metafield(namespace: "$app", key: "floor_net") { value }
    facts: metafield(namespace: "$app", key: "facts") { value }
    listings: metafield(namespace: "$app", key: "listings") { value }
    channels: metafield(namespace: "$app", key: "channels") { value }
  }
`;

interface ProductNode {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  media: { nodes: Array<{ image?: { url: string; altText: string | null } }> };
  variants: { nodes: Array<{ inventoryQuantity: number | null; inventoryItem: { tracked: boolean } }> };
  floorNet: { value: string } | null;
  facts: { value: string } | null;
  listings: { value: string } | null;
  channels: { value: string } | null;
}

function parseJson<T>(field: { value: string } | null, fallback: T): T {
  if (!field) return fallback;
  try {
    return JSON.parse(field.value) as T;
  } catch {
    return fallback;
  }
}

export class ShopifyInventoryStore implements InventoryStore {
  constructor(
    private readonly graphql: AdminGraphql,
    private readonly shop: string,
  ) {}

  private async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await this.graphql(query, { variables });
    const body = (await res.json()) as { data?: T; errors?: unknown };
    if (body.errors || !body.data) throw new Error(`Shopify GraphQL error: ${JSON.stringify(body.errors)}`);
    return body.data;
  }

  private toItem(p: ProductNode): InventoryItem {
    const variant = p.variants.nodes[0];
    const quantity = variant?.inventoryItem.tracked ? (variant.inventoryQuantity ?? 0) : null;
    const floor = p.floorNet ? Number(p.floorNet.value) : null;
    const base = {
      id: p.id,
      title: p.title,
      photos: p.media.nodes.flatMap((m) => (m.image ? [{ url: m.image.url, alt: m.image.altText }] : [])),
      quantity,
      floorNet: floor !== null && Number.isFinite(floor) ? floor : null,
      facts: parseJson<ItemFacts | null>(p.facts, null),
      listings: parseJson<ListingDraft[]>(p.listings, []),
      channels: parseJson<ChannelListingState[]>(p.channels, []),
      adminUrl: `https://admin.shopify.com/store/${this.shop.replace(".myshopify.com", "")}/products/${p.id.split("/").pop()}`,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
    return { ...base, stage: stageOf(base) };
  }

  async listItems(opts: ListItemsOptions = {}) {
    const data = await this.gql<{
      products: { nodes: ProductNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    }>(
      `#graphql
        ${PRODUCT_FIELDS}
        query Items($first: Int!, $after: String) {
          products(first: $first, after: $after, sortKey: CREATED_AT, reverse: true, query: "-status:archived") {
            nodes { ...ItemFields }
            pageInfo { hasNextPage endCursor }
          }
        }`,
      { first: Math.min(opts.limit ?? 50, 100), after: opts.after ?? null },
    );
    // Stage depends on metafields, which Shopify search can't filter on, so filter here.
    const items = data.products.nodes.map((p) => this.toItem(p)).filter((i) => !opts.stage || i.stage === opts.stage);
    const { hasNextPage, endCursor } = data.products.pageInfo;
    return { items, nextCursor: hasNextPage && endCursor ? endCursor : undefined };
  }

  async getItem(id: string) {
    const data = await this.gql<{ product: ProductNode | null }>(
      `#graphql
        ${PRODUCT_FIELDS}
        query Item($id: ID!) { product(id: $id) { ...ItemFields } }`,
      { id: normalizeProductId(id) },
    );
    return data.product ? this.toItem(data.product) : null;
  }

  private async setMetafield(id: string, key: string, type: string, value: string) {
    const data = await this.gql<{ metafieldsSet: { userErrors: Array<{ message: string }> } }>(
      `#graphql
        mutation SetField($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) { userErrors { field message } }
        }`,
      { metafields: [{ ownerId: normalizeProductId(id), namespace: NS, key, type, value }] },
    );
    const errors = data.metafieldsSet.userErrors;
    if (errors.length) throw new Error(`Couldn't save ${key}: ${errors.map((e) => e.message).join("; ")}`);
  }

  saveFacts(id: string, facts: ItemFacts) {
    return this.setMetafield(id, "facts", "json", JSON.stringify(facts));
  }

  saveFloor(id: string, floorNet: number) {
    return this.setMetafield(id, "floor_net", "number_decimal", floorNet.toFixed(2));
  }

  saveListings(id: string, drafts: ListingDraft[]) {
    return this.setMetafield(id, "listings", "json", JSON.stringify(drafts));
  }

  saveChannelStates(id: string, states: ChannelListingState[]) {
    return this.setMetafield(id, "channels", "json", JSON.stringify(states));
  }

  async zeroQuantity(id: string) {
    const productId = normalizeProductId(id);
    type Levels = {
      product: {
        variants: {
          nodes: Array<{
            inventoryItem: {
              id: string;
              tracked: boolean;
              inventoryLevels: {
                nodes: Array<{ location: { id: string }; quantities: Array<{ quantity: number }> }>;
              };
            };
          }>;
        };
      } | null;
    };
    const read = () =>
      this.gql<Levels>(
        `#graphql
          query Levels($id: ID!) {
            product(id: $id) {
              variants(first: 10) {
                nodes {
                  inventoryItem {
                    id
                    tracked
                    inventoryLevels(first: 10) {
                      nodes { location { id } quantities(names: ["available"]) { quantity } }
                    }
                  }
                }
              }
            }
          }`,
        { id: productId },
      );

    let data = await read();
    const untracked = data.product?.variants.nodes.filter((v) => !v.inventoryItem.tracked) ?? [];
    for (const v of untracked) {
      await this.gql(
        `#graphql
          mutation Track($id: ID!) { inventoryItemUpdate(id: $id, input: { tracked: true }) { userErrors { message } } }`,
        { id: v.inventoryItem.id },
      );
    }
    if (untracked.length) data = await read();

    const quantities = (data.product?.variants.nodes ?? []).flatMap((v) =>
      v.inventoryItem.inventoryLevels.nodes
        .filter((l) => (l.quantities[0]?.quantity ?? 0) !== 0)
        .map((l) => ({
          inventoryItemId: v.inventoryItem.id,
          locationId: l.location.id,
          quantity: 0,
          // Compare-and-set: fails if the quantity changed since we read it.
          changeFromQuantity: l.quantities[0]?.quantity ?? 0,
        })),
    );

    if (quantities.length) {
      const res = await this.gql<{ inventorySetQuantities: { userErrors: Array<{ message: string }> } }>(
        `#graphql
          mutation Zero($input: InventorySetQuantitiesInput!, $key: String!) {
            inventorySetQuantities(input: $input) @idempotent(key: $key) { userErrors { code field message } }
          }`,
        { input: { name: "available", reason: "correction", quantities }, key: randomUUID() },
      );
      const errors = res.inventorySetQuantities.userErrors;
      if (errors.length) throw new Error(`Couldn't set quantity to 0: ${errors.map((e) => e.message).join("; ")}`);
    }

    // A visible marker in the admin, even for items with no inventory location.
    await this.gql(
      `#graphql
        mutation Tag($id: ID!) { tagsAdd(id: $id, tags: ["sold"]) { userErrors { message } } }`,
      { id: productId },
    );
  }
}

/** Accepts a full GID or the numeric ID that's easier for people and assistants to pass around. */
export function normalizeProductId(id: string): string {
  return id.startsWith("gid://") ? id : `gid://shopify/Product/${id}`;
}
