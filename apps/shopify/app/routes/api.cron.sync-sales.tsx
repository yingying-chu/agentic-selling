import type { LoaderFunctionArgs } from "react-router";
import { syncAllShops } from "../sync.server";

// Vercel Cron calls this every 10 minutes (see vercel.json) with CRON_SECRET.
export const config = { maxDuration: 300 };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return Response.json({ ranAt: new Date().toISOString(), shops: await syncAllShops() });
};
