import { parentPort, workerData } from "node:worker_threads";
import { loadHomologationCredential, loadTrustedA1 } from "./certificate.ts";
import { signHomologationDps } from "./documents.ts";
import { FiscalError } from "./errors.ts";
import { sefinTransport, type SefinTransport } from "./sefin-transport.ts";

export type CertificateTask = {
  pfx: Uint8Array;
  passphrase: string;
  roots: string[];
  intermediates: string[];
  cnpj: string;
  unsigned?: Uint8Array;
  homologation?: { fingerprint: string; operation: Parameters<SefinTransport["request"]> };
};

const task = workerData as CertificateTask;
const pfx = Buffer.from(task.pfx.buffer, task.pfx.byteOffset, task.pfx.byteLength);
try {
  if (task.homologation) {
    const credential = loadHomologationCredential(pfx, task.passphrase, task);
    if (credential.fingerprint !== task.homologation.fingerprint) {
      throw new FiscalError("certificate-holder-mismatch", "O certificado da conexão diverge do cadastro.");
    }
    pfx.fill(0);
    const result = await sefinTransport(credential).request(...task.homologation.operation);
    parentPort?.postMessage({ result });
  } else {
    const key = loadTrustedA1(pfx, task.passphrase, task.roots, task.cnpj, task.intermediates);
    const { fingerprint, validFrom, validUntil } = key;
    const signed = task.unsigned ? signHomologationDps(Buffer.from(task.unsigned), key) : undefined;
    parentPort?.postMessage({ result: { fingerprint, validFrom, validUntil, signed } });
  }
} catch (error) {
  parentPort?.postMessage({ error: error instanceof FiscalError ? error.code : "invalid-certificate" });
} finally {
  pfx.fill(0);
}
