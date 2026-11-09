import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { FiscalError } from "./errors.ts";

type Outcome = "authorized" | "reconciled" | "rejected" | "indeterminate";
export type Claim = "reserved" | "previous-attempt";

export interface SubmissionLedger {
  check(id: string, documentHash: string): Promise<boolean>;
  claim(id: string, documentHash: string): Promise<Claim>;
  finish(id: string, outcome: Outcome): Promise<void>;
}

const reservation = z.object({
  documentHash: z.string().regex(/^[0-9a-f]{64}$/),
  at: z.iso.datetime(),
  event: z.literal("reserved"),
});

function ledgerError() {
  return new FiscalError("ledger-error", "Não foi possível conferir ou gravar o registro local da tentativa.");
}

export function fileLedger(directory: string): SubmissionLedger {
  const base = resolve(directory);
  const filePath = (id: string) => resolve(base, `${createHash("sha256").update(id).digest("hex")}.jsonl`);

  async function check(id: string, documentHash: string) {
    let saved: z.infer<typeof reservation>;
    try {
      const handle = await open(filePath(id), "r");
      try {
        const buffer = Buffer.alloc(1024);
        const { bytesRead } = await handle.read(buffer);
        const end = buffer.subarray(0, bytesRead).indexOf(10);
        if (end < 0) throw ledgerError();
        saved = reservation.parse(JSON.parse(buffer.toString("utf8", 0, end)));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw ledgerError();
    }
    if (saved.documentHash !== documentHash) {
      throw new FiscalError("dps-id-reused", "O identificador da DPS já foi reservado para outro XML.");
    }
    return true;
  }

  return {
    check,
    async claim(id, documentHash) {
      const path = filePath(id);
      try {
        await mkdir(base, { recursive: true, mode: 0o700 });
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ documentHash, at: new Date().toISOString(), event: "reserved" }) + "\n");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return "reserved";
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw ledgerError();
      }

      if (!await check(id, documentHash)) throw ledgerError();
      return "previous-attempt";
    },

    async finish(id, outcome) {
      try {
        const handle = await open(filePath(id), "a", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ at: new Date().toISOString(), event: outcome }) + "\n");
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch {
        throw ledgerError();
      }
    },
  };
}
