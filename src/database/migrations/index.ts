import type { Queryable } from "../client.js";
import { initialSchema } from "./001-initial-schema.js";

export interface Migration {
  /** Sortable, never-renamed id, e.g. 002_add_column. */
  id: string;
  description: string;
  up(tx: Queryable): Promise<void>;
}

/** Ordered list of migrations. Append new ones; never edit an applied migration. */
export const MIGRATIONS: readonly Migration[] = [initialSchema];
