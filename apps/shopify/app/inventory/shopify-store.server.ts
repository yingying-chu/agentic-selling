import { randomUUID } from "node:crypto";
import {
  stageOf,
  type ChannelListingState,
  type InventoryItem,
  type InventoryStore,
  type ItemFacts,
  type ListingDraft,
  type ListItemsOptions,
  type NewPhoto,
  type PhotoKind,
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
    description
    createdAt
    updatedAt
    media(first: 30) {
      nodes {
        id
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
    photoKinds: metafield(namespace: "$app", key: "photo_kinds") { value }
  }
`;

/** Media ID → what kind of photo it is. Media without an entry are the seller's originals. */
type PhotoKinds = Record<string, { kind: PhotoKind; sourceUrl?: string }>;

interface ProductNode {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  media: { nodes: Array<{ id: string; image?: { url: string; altText: string | null } }> };
  variants: { nodes: Array<{ inventoryQuantity: number | null; inventoryItem: { tracked: boolean } }> };
  floorNet: { value: string } | null;
  facts: { value: string } | null;
  listings: { value: string } | null;
  channels: { value: string } | null;
  photoKinds: { value: string } | null;
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
    const kinds = parseJson<PhotoKinds>(p.photoKinds, {});
    const base = {
      id: p.id,
      title: p.title,
      photos: p.media.nodes.flatMap((m) =>
        m.image
          ? [{ url: m.image.url, alt: m.image.altText, kind: kinds[m.id]?.kind ?? ("original" as const), sourceUrl: kinds[m.id]?.sourceUrl }]
          : [],
      ),
      quantity,
      floorNet: floor !== null && Number.isFinite(floor) ? floor : null,
      notes: p.description.trim() || null,
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

  /** Uploads files to Shopify's staging bucket and returns URLs usable as media sources. */
  private async stage(photos: NewPhoto[]): Promise<string[]> {
    const data = await this.gql<{
      stagedUploadsCreate: {
        stagedTargets: Array<{ url: string; resourceUrl: string; parameters: Array<{ name: string; value: string }> }>;
        userErrors: Array<{ message: string }>;
      };
    }>(
      `#graphql
        mutation Stage($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets { url resourceUrl parameters { name value } }
            userErrors { field message }
          }
        }`,
      {
        input: photos.map((p, i) => ({
          filename: `photo-${Date.now()}-${i}.${p.mediaType.split("/")[1] ?? "jpg"}`,
          mimeType: p.mediaType,
          resource: "IMAGE",
          httpMethod: "POST",
          fileSize: String(p.data.byteLength),
        })),
      },
    );
    const errors = data.stagedUploadsCreate.userErrors;
    if (errors.length) throw new Error(`Couldn't prepare upload: ${errors.map((e) => e.message).join("; ")}`);
    const targets = data.stagedUploadsCreate.stagedTargets;
    await Promise.all(
      targets.map(async (t, i) => {
        const form = new FormData();
        for (const p of t.parameters) form.append(p.name, p.value);
        form.append("file", new Blob([Uint8Array.from(photos[i]!.data)], { type: photos[i]!.mediaType }), `photo-${i}`);
        const res = await fetch(t.url, { method: "POST", body: form });
        if (!res.ok) throw new Error(`Photo upload failed (${res.status})`);
      }),
    );
    return targets.map((t) => t.resourceUrl);
  }

  async createItem(title: string, photos: NewPhoto[], notes?: string): Promise<string> {
    const sources = await this.stage(photos);
    const data = await this.gql<{
      productCreate: {
        product: { id: string; variants: { nodes: Array<{ inventoryItem: { id: string } }> } } | null;
        userErrors: Array<{ message: string }>;
      };
    }>(
      `#graphql
        mutation Create($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
          productCreate(product: $product, media: $media) {
            product { id variants(first: 1) { nodes { inventoryItem { id } } } }
            userErrors { field message }
          }
        }`,
      {
        product: { title, status: "DRAFT", ...(notes ? { descriptionHtml: `<p>${escapeHtml(notes)}</p>` } : {}) },
        media: sources.map((src, i) => ({ originalSource: src, mediaContentType: "IMAGE", alt: photos[i]!.alt })),
      },
    );
    const product = data.productCreate.product;
    if (!product) throw new Error(`Couldn't create item: ${data.productCreate.userErrors.map((e) => e.message).join("; ")}`);
    await this.setQuantity(product.id, 1);
    return product.id;
  }

  async renameItem(id: string, title: string): Promise<void> {
    await this.gql(
      `#graphql
        mutation Rename($product: ProductUpdateInput!) { productUpdate(product: $product) { userErrors { message } } }`,
      { product: { id: normalizeProductId(id), title } },
    );
  }

  async addPhotos(id: string, photos: NewPhoto[]): Promise<void> {
    if (!photos.length) return;
    const productId = normalizeProductId(id);
    const sources = await this.stage(photos);
    const data = await this.gql<{
      productUpdate: { product: { media: { nodes: Array<{ id: string }> } } | null; userErrors: Array<{ message: string }> };
    }>(
      `#graphql
        mutation AddMedia($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
          productUpdate(product: $product, media: $media) {
            product { media(first: 250) { nodes { id } } }
            userErrors { field message }
          }
        }`,
      {
        product: { id: productId },
        media: sources.map((src, i) => ({ originalSource: src, mediaContentType: "IMAGE", alt: photos[i]!.alt })),
      },
    );
    // New media are appended, so they're the last N.
    const added = (data.productUpdate.product?.media.nodes ?? []).slice(-photos.length);
    if (!data.productUpdate.product) {
      throw new Error(`Couldn't add photos: ${data.productUpdate.userErrors.map((e) => e.message).join("; ")}`);
    }
    const current = await this.gql<{ product: { photoKinds: { value: string } | null } | null }>(
      `#graphql
        query Kinds($id: ID!) { product(id: $id) { photoKinds: metafield(namespace: "$app", key: "photo_kinds") { value } } }`,
      { id: productId },
    );
    const kinds = parseJson<PhotoKinds>(current.product?.photoKinds ?? null, {});
    added.forEach((m, i) => {
      const p = photos[i];
      if (p) kinds[m.id] = { kind: p.kind, ...(p.sourceUrl ? { sourceUrl: p.sourceUrl } : {}) };
    });
    await this.setMetafield(productId, "photo_kinds", "json", JSON.stringify(kinds));
  }

  /** Tracks inventory and sets the quantity at the item's first location. */
  private async setQuantity(productId: string, quantity: number) {
    type Item = {
      product: {
        variants: {
          nodes: Array<{
            inventoryItem: {
              id: string;
              tracked: boolean;
              inventoryLevels: { nodes: Array<{ location: { id: string }; quantities: Array<{ quantity: number }> }> };
            };
          }>;
        };
      } | null;
    };
    const read = () =>
      this.gql<Item>(
        `#graphql
          query Level($id: ID!) {
            product(id: $id) {
              variants(first: 1) {
                nodes {
                  inventoryItem {
                    id
                    tracked
                    inventoryLevels(first: 1) { nodes { location { id } quantities(names: ["available"]) { quantity } } }
                  }
                }
              }
            }
          }`,
        { id: productId },
      );
    let item = (await read()).product?.variants.nodes[0]?.inventoryItem;
    if (!item) return;
    if (!item.tracked) {
      await this.gql(
        `#graphql
          mutation Track($id: ID!) { inventoryItemUpdate(id: $id, input: { tracked: true }) { userErrors { message } } }`,
        { id: item.id },
      );
      item = (await read()).product?.variants.nodes[0]?.inventoryItem;
    }
    const level = item?.inventoryLevels.nodes[0];
    if (!item || !level) return;
    await this.gql(
      `#graphql
        mutation SetQty($input: InventorySetQuantitiesInput!, $key: String!) {
          inventorySetQuantities(input: $input) @idempotent(key: $key) { userErrors { code field message } }
        }`,
      {
        input: {
          name: "available",
          reason: "correction",
          quantities: [
            { inventoryItemId: item.id, locationId: level.location.id, quantity, changeFromQuantity: level.quantities[0]?.quantity ?? 0 },
          ],
        },
        key: randomUUID(),
      },
    );
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

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Accepts a full GID or the numeric ID that's easier for people and assistants to pass around. */
export function normalizeProductId(id: string): string {
  return id.startsWith("gid://") ? id : `gid://shopify/Product/${id}`;
}
