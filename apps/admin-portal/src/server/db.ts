import "server-only";
import mongoose, { Connection } from "mongoose";
import { config } from "@/config/env";

/**
 * Multi-database connection manager for the admin portal.
 *
 * The platform shards data across four MongoDB databases owned by different
 * services. The admin portal reads directly from all four (Rule #4: reads
 * direct; writes go through the gateway). Connections are cached on
 * `globalThis` so Next.js dev HMR and serverless reuse them instead of
 * opening a new pool on every request.
 */

type DbName = "core" | "billing" | "campaign" | "automation" | "bsp";

const URIS: Record<DbName, string | undefined> = {
  core: config.mongodb.core,
  billing: config.mongodb.billing,
  campaign: config.mongodb.campaign,
  automation: config.mongodb.automation,
  bsp: config.mongodb.bsp,
};

interface ConnCacheEntry {
  conn: Connection | null;
  promise: Promise<Connection> | null;
}

type ConnCache = Record<DbName, ConnCacheEntry>;

const globalForDb = globalThis as unknown as { __adminDbCache?: ConnCache };

function emptyCache(): ConnCache {
  return {
    core: { conn: null, promise: null },
    billing: { conn: null, promise: null },
    campaign: { conn: null, promise: null },
    automation: { conn: null, promise: null },
    bsp: { conn: null, promise: null },
  };
}

const cache: ConnCache = globalForDb.__adminDbCache ?? (globalForDb.__adminDbCache = emptyCache());

/**
 * Returns a ready Mongoose connection for the given database, opening it on
 * first use. Read-only intent — never use these connections to perform
 * platform mutations (those go through the gateway).
 */
const ALLOWED_DBS: Record<DbName, boolean> = {
  core: true,
  billing: true,
  campaign: true,
  automation: true,
  bsp: true,
};

export async function getConnection(db: DbName = "core"): Promise<Connection> {
  if (!db || !Object.prototype.hasOwnProperty.call(ALLOWED_DBS, db)) {
    throw new Error(`Invalid database name: ${db}`);
  }
  const entry = cache[db];
  if (entry.conn && entry.conn.readyState === 1) return entry.conn;

  const uri = URIS[db];
  if (!uri) {
    throw new Error(
      `[admin-portal/db] Missing connection string for "${db}" database. ` +
        `Set the corresponding MONGODB_URI* env var.`
    );
  }

  if (!entry.promise) {
    entry.promise = mongoose
      .createConnection(uri, {
        // Lean read pool — the admin portal is low-concurrency.
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 8000,
      })
      .asPromise()
      .then((conn) => {
        entry.conn = conn;
        return conn;
      })
      .catch((err) => {
        entry.promise = null; // allow retry on next request
        throw err;
      });
  }

  return entry.promise;
}

export type { DbName };
