import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

if (process.env.NODE_ENV !== "production") {
  // Vite's dev server doesn't put .env into process.env for server code; Vercel sets real env vars in production.
  try {
    process.loadEnvFile();
  } catch {
    // No .env file; rely on the environment.
  }
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient();
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient();

export default prisma;
