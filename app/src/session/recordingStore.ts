import type { RecordedChunk, RecordingMeta } from "./recording";

// Minimal promise wrapper over IndexedDB. Chunks are stored in numbered batches so a long recording
// is written incrementally (a crash loses at most the last flush interval).

const DB_NAME = "biobridge";
const DB_VERSION = 1;
const META = "recordings";
const BATCHES = "chunkBatches";

type BatchRow = { rec: string; n: number; items: RecordedChunk[] };

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export class RecordingStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  static isAvailable(): boolean {
    return typeof indexedDB !== "undefined";
  }

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id" });
        if (!db.objectStoreNames.contains(BATCHES)) db.createObjectStore(BATCHES, { keyPath: ["rec", "n"] });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  async saveMeta(meta: RecordingMeta): Promise<void> {
    const tx = (await this.db()).transaction(META, "readwrite");
    tx.objectStore(META).put(meta);
    await done(tx);
  }

  async appendBatch(rec: string, n: number, items: RecordedChunk[]): Promise<void> {
    const tx = (await this.db()).transaction(BATCHES, "readwrite");
    tx.objectStore(BATCHES).put({ rec, n, items } satisfies BatchRow);
    await done(tx);
  }

  async list(): Promise<RecordingMeta[]> {
    const tx = (await this.db()).transaction(META, "readonly");
    const all = await request(tx.objectStore(META).getAll() as IDBRequest<RecordingMeta[]>);
    return all.sort((a, b) => b.startedAt - a.startedAt);
  }

  async load(id: string): Promise<{ meta: RecordingMeta; chunks: RecordedChunk[] }> {
    const tx = (await this.db()).transaction([META, BATCHES], "readonly");
    const meta = await request(tx.objectStore(META).get(id) as IDBRequest<RecordingMeta | undefined>);
    if (!meta) throw new Error(`Recording ${id} not found.`);
    const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
    const batches = await request(tx.objectStore(BATCHES).getAll(range) as IDBRequest<BatchRow[]>);
    batches.sort((a, b) => a.n - b.n);
    return { meta, chunks: batches.flatMap((b) => b.items) };
  }

  /** Stores an imported recording in one go. */
  async put(meta: RecordingMeta, chunks: RecordedChunk[]): Promise<void> {
    const tx = (await this.db()).transaction([META, BATCHES], "readwrite");
    tx.objectStore(META).put(meta);
    const size = 2000;
    for (let i = 0; i * size < chunks.length; i++) {
      tx.objectStore(BATCHES).put({ rec: meta.id, n: i, items: chunks.slice(i * size, (i + 1) * size) } satisfies BatchRow);
    }
    await done(tx);
  }

  async delete(id: string): Promise<void> {
    const tx = (await this.db()).transaction([META, BATCHES], "readwrite");
    tx.objectStore(META).delete(id);
    tx.objectStore(BATCHES).delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
    await done(tx);
  }
}
