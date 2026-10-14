import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { createConnection, listConnections, revokeConnection } from "../mcp/connections.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const connections = await listConnections(session.shop);
  return {
    connections: connections.map((c) => ({
      id: c.id,
      label: c.label,
      createdAt: c.createdAt.toISOString(),
      lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") === "revoke") {
    await revokeConnection(session.shop, String(form.get("id")));
    return { revoked: true as const };
  }
  const label = String(form.get("label") || "My AI assistant").slice(0, 60);
  const secret = await createConnection(session.shop, label);
  return {
    url: `${process.env.SHOPIFY_APP_URL}/mcp?key=${secret}`,
    phoneUrl: `${process.env.SHOPIFY_APP_URL}/s/${secret}`,
  };
};

export default function Connect() {
  const { connections } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const url = result && "url" in result ? result.url : null;
  const phoneUrl = result && "phoneUrl" in result ? result.phoneUrl : null;

  return (
    <s-page heading="Connect your AI assistant">
      <s-section heading="Sell by chatting">
        <s-paragraph>
          Connect Claude or ChatGPT and just say "list my new stuff" or "my jacket sold on Poshmark". Your assistant
          looks at your photos, writes the listings, and keeps track of what's live where.
        </s-paragraph>
        <Form method="post">
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-text-field name="label" label="Name this connection" placeholder="e.g. Claude on my phone" />
            <s-button type="submit" variant="primary">
              Create connection link
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      {url && (
        <s-section heading="Your links">
          <s-banner tone="warning">
            Copy it now; it won't be shown again. Anyone with this link can manage your items, so keep it private.
          </s-banner>
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-text-field label="Link" value={url} readOnly />
            <s-button onClick={() => navigator.clipboard.writeText(url)}>Copy</s-button>
          </s-stack>
          {phoneUrl && (
            <>
              <s-heading>Your phone</s-heading>
              <s-paragraph>Open this on your phone and add it to your home screen to snap and sell from anywhere.</s-paragraph>
              <s-stack direction="inline" gap="small" alignItems="end">
                <s-text-field label="Phone link" value={phoneUrl} readOnly />
                <s-button onClick={() => navigator.clipboard.writeText(phoneUrl)}>Copy</s-button>
              </s-stack>
            </>
          )}
          <s-heading>Claude</s-heading>
          <s-paragraph>Settings → Connectors → Add custom connector → paste the link.</s-paragraph>
          <s-heading>ChatGPT</s-heading>
          <s-paragraph>
            Settings → Apps &amp; Connectors → Advanced → turn on Developer mode → Create → paste the link. Needs a paid
            ChatGPT plan.
          </s-paragraph>
        </s-section>
      )}

      {connections.length > 0 && (
        <s-section heading="Connected assistants">
          <s-stack direction="block" gap="small">
            {connections.map((c) => (
              <Form method="post" key={c.id}>
                <input type="hidden" name="intent" value="revoke" />
                <input type="hidden" name="id" value={c.id} />
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-text>{c.label}</s-text>
                  <s-text color="subdued">
                    {c.lastUsedAt ? `Last used ${new Date(c.lastUsedAt).toLocaleDateString()}` : "Never used"}
                  </s-text>
                  <s-button type="submit" variant="tertiary" tone="critical">
                    Disconnect
                  </s-button>
                </s-stack>
              </Form>
            ))}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
