import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WriteEnvelope, WriteRequest } from "./store.ts";

export interface Batch {
  id: string;
  seq: number;
  count: number;
  timeout_s?: number;
}
export interface BatchState {
  id: string;
  target: string | null;
  state: "open" | "complete" | "failed" | "expired";
  count: number;
  timeout_s: number;
  last_received_at: string;
  received: number[];
  revisions: Record<string, string>;
  failed_seq: number | null;
  reason: WriteEnvelope["error"];
}
export interface BatchStep {
  request: WriteRequest;
  received_at: string;
}
export async function saveBatchFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
export const batchPath = (root: string, id: string) => join(root, "batches", id);
export const batchView = (state: BatchState) => {
  const applied = Object.keys(state.revisions)
    .map(Number)
    .sort((a, b) => a - b);
  return {
    batch_id: state.id,
    state: state.state,
    count: state.count,
    applied,
    waiting: state.state === "open" ? state.received.filter((seq) => !applied.includes(seq)).sort((a, b) => a - b) : [],
    missing: Array.from({ length: state.count }, (_, i) => i + 1).filter((seq) => !state.received.includes(seq)),
    revisions: state.revisions,
    failed_seq: state.failed_seq,
    reason: state.reason,
  };
};
export async function readBatches(root: string, now: Date): Promise<BatchState[]> {
  let names: string[];
  try {
    names = await readdir(join(root, "batches"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const states: BatchState[] = [];
  for (const name of names.sort()) {
    const path = join(batchPath(root, name), "state.json");
    let state: BatchState;
    try {
      state = JSON.parse(await readFile(path, "utf8")) as BatchState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (state.state === "open" && now.getTime() - Date.parse(state.last_received_at) > state.timeout_s * 1000) {
      state.state = "expired";
      await saveBatchFile(path, state);
    }
    states.push(state);
  }
  return states;
}
