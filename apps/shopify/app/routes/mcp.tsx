import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createMcpHandler } from "mcp-handler";
import { unauthenticated } from "../shopify.server";
import { ShopifyInventoryStore } from "../inventory/shopify-store.server";
import { shopForKey } from "../mcp/connections.server";
import { INSTRUCTIONS, registerTools } from "../mcp/tools.server";

// MCP endpoint for chat assistants: POST /mcp?key=<secret>.

async function handle(request: Request) {
  const shop = await shopForKey(new URL(request.url).searchParams.get("key"));
  if (!shop) {
    return Response.json(
      { error: "Unknown or revoked connection link. Create a new one in the app's Connect AI page." },
      { status: 401 },
    );
  }

  // Uses the shop's offline token saved at install, so no browser session is needed.
  const { admin } = await unauthenticated.admin(shop);
  const store = new ShopifyInventoryStore(admin.graphql, shop);

  // Stateless: a fresh server per request, scoped to this shop.
  const handler = createMcpHandler((server) => registerTools(server, store, shop), {
    serverInfo: { name: "agentic-selling", version: "0.1.0" },
    instructions: INSTRUCTIONS,
  });
  return handler(request);
}

export const loader = ({ request }: LoaderFunctionArgs) => handle(request);
export const action = ({ request }: ActionFunctionArgs) => handle(request);
