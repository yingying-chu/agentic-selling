import type { Config } from "@react-router/dev/config";
import { vercelPreset } from "@vercel/react-router/vite";

export default {
  ssr: true,
  presets: [vercelPreset()],
  // Ship every route up front. With lazy discovery the browser asks /__manifest, which Vercel
  // serves from one server bundle that doesn't know routes split into others (the phone pages,
  // with their longer maxDuration), so in-app links to them 404.
  routeDiscovery: { mode: "initial" },
} satisfies Config;
