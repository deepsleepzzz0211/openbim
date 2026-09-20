import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Blob storage abstraction. The local-disk implementation ships by default;
 * an S3-compatible implementation can be added without touching route code
 * (keys are server-generated, never derived from user input).
 */
export interface BlobStore {
  /** Persist a buffer under key, return the byte length written. */
  put(key: string, data: Uint8Array): Promise<number>;
  /** Persist a node stream under key, return the byte length written. */
  putStream(key: string, stream: Readable): Promise<number>;
  /** Open a writable sink for `pipeline(source, ..., store.writeStream(key))`. */
  writeStream(key: string): Promise<Writable>;
  /** Read a whole object. */
  get(key: string): Promise<Buffer>;
  /** Open an object as a stream (for HTTP responses). */
  getStream(key: string): Promise<Readable>;
  /** Delete an object if it exists. */
  delete(key: string): Promise<void>;
  /** Cheap existence probe (used for optional sidecars like model.glb.br). */
  exists(key: string): Promise<boolean>;
  /** Relocate an object (used to promote uploads to content-addressed keys). */
  move(from: string, to: string): Promise<void>;
  /** Absolute filesystem path (local implementation only; used by workers). */
  pathFor(key: string): string;
}

export class LocalDiskBlobStore implements BlobStore {
  constructor(readonly root: string) {}

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) {
      throw new Error(`invalid blob key: ${key}`);
    }
    return full;
  }

  pathFor(key: string): string {
    return this.resolve(key);
  }

  async put(key: string, data: Uint8Array): Promise<number> {
    const full = this.resolve(key);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, data);
    return data.byteLength;
  }

  async putStream(key: string, stream: Readable): Promise<number> {
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.byteLength;
        cb(null, chunk);
      },
    });
    await pipeline(stream, counter, await this.writeStream(key));
    return size;
  }

  async writeStream(key: string): Promise<Writable> {
    const full = this.resolve(key);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    return fs.createWriteStream(full);
  }

  async get(key: string): Promise<Buffer> {
    return fsp.readFile(this.resolve(key));
  }

  async getStream(key: string): Promise<Readable> {
    return fs.createReadStream(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await fsp.rm(this.resolve(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fsp.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async move(from: string, to: string): Promise<void> {
    const src = this.resolve(from);
    const dest = this.resolve(to);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fsp.rename(src, dest);
    } catch {
      // Windows rejects rename onto an existing file; content-addressed
      // collisions carry identical bytes, so overwrite via copy.
      await fsp.copyFile(src, dest);
      await fsp.rm(src, { force: true });
    }
  }
}
