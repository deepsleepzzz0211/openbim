#!/usr/bin/env node
/**
 * OpenBIM Hub backup: consistent SQLite snapshot (VACUUM INTO, online-safe)
 * + a full copy of the blob directory (model artifacts, snapshots).
 *
 * Usage (from apps/api):
 *   DATABASE_URL="file:..." DATA_DIR="..." node ../scripts/backup.mjs [targetDir]
 *
 * For PostgreSQL deployments use pg_dump instead of VACUUM INTO and keep the
 * blob copy step unchanged (see docs/deployment.md).
 */
import { createRequire } from "node:module";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const require2 = createRequire(import.meta.url);
// scripts/ -> repo root
const repoRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(resolve("apps/api"), "data");
const target = resolve(process.argv[2] || join(dataDir, "backups", new Date().toISOString().replace(/[:.]/g, "-")));

async function main() {
  await mkdir(target, { recursive: true });

  // 1) consistent DB snapshot (works while the server is running)
  if (process.env.DATABASE_URL?.startsWith("file:")) {
    const { PrismaClient } = require2(join(repoRoot, "apps/api/node_modules/@prisma/client"));
    process.env.DATABASE_URL ??= `file:${join(dataDir, "app.db")}`;
    const db = new PrismaClient();
    const dbPath = join(target, "app.db");
    await db.$queryRawUnsafe(`VACUUM INTO '${dbPath.replace(/'/g, "''")}'`);
    await db.$disconnect();
    console.log(`db snapshot: ${dbPath}`);
  } else {
    await writeFile(join(target, "README.txt"), "PostgreSQL deployment: restore from pg_dump output instead.\n");
    console.log("non-sqlite database: skipped VACUUM INTO");
  }

  // 2) blobs (model artifacts, issue snapshots)
  const blobsSrc = join(dataDir, "blobs");
  const blobsDst = join(target, "blobs");
  await cp(blobsSrc, blobsDst, { recursive: true });
  console.log(`blobs copied: ${blobsSrc} -> ${blobsDst}`);

  // 3) manifest
  await writeFile(join(target, "manifest.json"), JSON.stringify({ createdAt: new Date().toISOString(), dataDir }, null, 2));
  console.log(`backup complete: ${target}`);
}

main().catch((err) => {
  console.error("backup failed:", err.message);
  process.exit(1);
});
