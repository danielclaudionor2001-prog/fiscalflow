import { parentPort, workerData } from "node:worker_threads";
import { loadTrustedA1 } from "./certificate.ts";
import { signHomologationDps } from "./documents.ts";
import { FiscalError } from "./errors.ts";

export type CertificateTask = {
  pfx: Uint8Array;
  passphrase: string;
  roots: string[];
  intermediates: string[];
  cnpj: string;
  unsigned?: Uint8Array;
};

const task = workerData as CertificateTask;
const pfx = Buffer.from(task.pfx.buffer, task.pfx.byteOffset, task.pfx.byteLength);
try {
  const key = loadTrustedA1(pfx, task.passphrase, task.roots, task.cnpj, task.intermediates);
  const { fingerprint, validFrom, validUntil } = key;
  const signed = task.unsigned ? signHomologationDps(Buffer.from(task.unsigned), key) : undefined;
  parentPort?.postMessage({ result: { fingerprint, validFrom, validUntil, signed } });
} catch (error) {
  parentPort?.postMessage({ error: error instanceof FiscalError ? error.code : "invalid-certificate" });
} finally {
  pfx.fill(0);
}
