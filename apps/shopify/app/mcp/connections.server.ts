import { createHash, randomBytes } from "node:crypto";
import db from "../db.server";

// Each assistant connection is a secret link: https://<app>/mcp?key=<secret>.
// Claude and ChatGPT both accept a plain URL for custom connectors, so this
// works today. Before the public launch, swap it for OAuth (mcp-handler's
// withMcpAuth) so sellers sign in instead of pasting a secret.

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

export async function createConnection(shop: string, label: string) {
  const secret = randomBytes(24).toString("base64url");
  await db.mcpConnection.create({ data: { shop, label, tokenHash: hash(secret) } });
  return secret;
}

export async function shopForKey(secret: string | null): Promise<string | null> {
  if (!secret) return null;
  const conn = await db.mcpConnection.findUnique({ where: { tokenHash: hash(secret) } });
  if (!conn) return null;
  // Best effort; a failed timestamp update shouldn't block the request.
  db.mcpConnection.update({ where: { id: conn.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return conn.shop;
}

export function listConnections(shop: string) {
  return db.mcpConnection.findMany({ where: { shop }, orderBy: { createdAt: "desc" } });
}

export function revokeConnection(shop: string, id: string) {
  return db.mcpConnection.deleteMany({ where: { shop, id } });
}
