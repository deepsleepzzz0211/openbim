import { loadConfig, isDevSecret } from "./config";
import { createDb } from "./db";
import { LocalDiskBlobStore } from "./blobStore";
import { createConversionService } from "./conversion";
import { NativeConversionClient } from "./conversion/nativeClient";
import { buildApp } from "./app";
import { processVersion } from "./routes/models";

async function main(): Promise<void> {
  const config = loadConfig();
  if (isDevSecret(config.jwtSecret)) {
    console.warn("[openbim-hub] WARNING: using the development JWT secret. Set JWT_SECRET in production.");
  }
  const db = createDb(config.databaseUrl);
  const blobs = new LocalDiskBlobStore(config.dataDir);
  const conversion = createConversionService(
    config.conversionMode,
    config.concurrency,
    config.nativeWorkerUrl
      ? new NativeConversionClient({ baseUrl: config.nativeWorkerUrl, token: config.nativeWorkerToken, timeoutMs: config.nativeTimeoutMs })
      : null
  );

  const app = await buildApp({ config, db, blobs, conversion });

  // Recover versions interrupted by a restart (or stuck from a crashed worker).
  try {
    const interrupted = await db.version.updateMany({
      where: { status: { in: ["PENDING", "PROCESSING"] } },
      data: { status: "PENDING" },
    });
    if (interrupted.count > 0) {
      app.log.warn({ count: interrupted.count }, "re-enqueuing interrupted conversions");
    }
  } catch {
    // database not migrated yet on first boot; ignore
  }

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    app.log.error(err, "failed to start");
    process.exit(1);
  }

  // Re-run conversions that were interrupted by a restart.
  const pending = await db.version.findMany({ where: { status: "PENDING" }, select: { id: true } });
  for (const version of pending) {
    void processVersion(app, version.id);
  }
}

void main();
