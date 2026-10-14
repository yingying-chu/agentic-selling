import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { CHANNELS, CHANNEL_IDS } from "@agentic-selling/core";
import { authenticate } from "../shopify.server";
import { getSettings, isChannelId, updateSettings } from "../selling.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { settings: await getSettings(session.shop) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const labelCost = Number(form.get("labelCost"));
  await updateSettings(session.shop, {
    enabledChannels: form.getAll("channels").map(String).filter(isChannelId),
    labelCost: Number.isFinite(labelCost) && labelCost >= 0 ? labelCost : 8,
    sellerPaysShipping: form.get("sellerPaysShipping") === "on",
  });
  return { ok: true };
};

const CHOOSABLE = CHANNEL_IDS.filter((c) => c !== "shopify");

export default function Settings() {
  const { settings } = useLoaderData<typeof loader>();
  const saved = useActionData<typeof action>();

  return (
    <s-page heading="Settings">
      {saved?.ok && <s-banner tone="success">Saved.</s-banner>}
      <Form method="post">
        <s-section heading="Where do you have accounts?">
          <s-paragraph>We only recommend platforms you've ticked.</s-paragraph>
          <s-stack direction="block" gap="small">
            {CHOOSABLE.map((c) => (
              <s-checkbox
                key={c}
                name="channels"
                value={c}
                label={CHANNELS[c].name}
                defaultChecked={settings.enabledChannels.includes(c)}
              />
            ))}
          </s-stack>
        </s-section>
        <s-section heading="Shipping">
          <s-stack direction="block" gap="base">
            <s-number-field
              name="labelCost"
              label="Typical shipping label cost"
              prefix="$"
              min={0}
              step={0.5}
              value={settings.labelCost.toString()}
            />
            <s-checkbox
              name="sellerPaysShipping"
              label="I offer free shipping where the platform lets me choose"
              defaultChecked={settings.sellerPaysShipping}
            />
          </s-stack>
        </s-section>
        <s-section>
          <s-button type="submit" variant="primary">
            Save
          </s-button>
        </s-section>
      </Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
