import { PrismaClient } from "@prisma/client";

export function createDb(databaseUrl?: string): PrismaClient {
  if (databaseUrl) {
    process.env.DATABASE_URL = databaseUrl;
  }
  return new PrismaClient();
}

export type Db = PrismaClient;
