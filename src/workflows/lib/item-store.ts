import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What the server remembers between runs: which category a purchased item
 * belongs in, and which transactions were already enriched from which receipt.
 *
 * A small JSON file in YNAB_MCP_STATE_DIR (default ./state). Mount a volume
 * there in Docker; without one, mappings last until the container is recreated.
 */
export interface ItemStoreData {
  version: 1;
  /** `${source}:${key}` -> category id */
  items: Record<string, { categoryId: string; name: string; updatedAt: string }>;
  /** transaction id -> receipt id */
  enriched: Record<string, string>;
}

const empty = (): ItemStoreData => ({ version: 1, items: {}, enriched: {} });

export class ItemStore {
  private data: ItemStoreData;

  constructor(private readonly path: string | null) {
    this.data = empty();
    if (!path) return;
    try {
      this.data = { ...empty(), ...(JSON.parse(readFileSync(path, "utf8")) as ItemStoreData) };
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  static open(): ItemStore {
    const dir = process.env.YNAB_MCP_STATE_DIR ?? join(process.cwd(), "state");
    mkdirSync(dir, { recursive: true });
    return new ItemStore(join(dir, "items.json"));
  }

  static key(source: string, key: string): string {
    return `${source.toLowerCase()}:${key.trim().toLowerCase().replace(/\s+/g, " ")}`;
  }

  categoryFor(source: string, key: string): string | undefined {
    return this.data.items[ItemStore.key(source, key)]?.categoryId;
  }

  setCategory(source: string, key: string, name: string, categoryId: string) {
    this.data.items[ItemStore.key(source, key)] = { categoryId, name, updatedAt: new Date().toISOString() };
  }

  enrichedReceipt(transactionId: string): string | undefined {
    return this.data.enriched[transactionId];
  }

  markEnriched(transactionId: string, receiptId: string) {
    this.data.enriched[transactionId] = receiptId;
  }

  receiptUsed(receiptId: string): boolean {
    return Object.values(this.data.enriched).includes(receiptId);
  }

  list() {
    return Object.entries(this.data.items).map(([key, v]) => ({ key, ...v }));
  }

  save() {
    if (!this.path) return;
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.path);
  }
}
