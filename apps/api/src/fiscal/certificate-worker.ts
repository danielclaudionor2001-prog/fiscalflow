import { parentPort, workerData } from "node:worker_threads";
import { loadHomologationCredential, loadTrustedA1 } from "./certificate.ts";
import { signHomologationDps } from "./documents.ts";
import { FiscalError } from "./errors.ts";
import { summarizeSefinProductionNote } from "./sefin.ts";
import { getSefinProductionNote, sefinTransport, type SefinTransport } from "./sefin-transport.ts";

export type CertificateTask = {
  pfx: Uint8Array;
  passphrase: string;
  roots: string[];
  intermediates: string[];
  cnpj: string;
  unsigned?: Uint8Array;
  sefin?: { fingerprint: string } & (
    | { kind: "homologation"; operation: Parameters<SefinTransport["request"]> }
    | { kind: "production-lookup"; accessKey: string }
  );
};

const task = workerData as CertificateTask;
const pfx = Buffer.from(task.pfx.buffer, task.pfx.byteOffset, task.pfx.byteLength);
try {
  if (task.sefin) {
    const credential = loadHomologationCredential(pfx, task.passphrase, task);
    if (credential.fingerprint !== task.sefin.fingerprint) {
      throw new FiscalError("certificate-holder-mismatch", "O certificado da conexão diverge do cadastro.");
    }
    pfx.fill(0);
    const result = task.sefin.kind === "homologation"
      ? await sefinTransport(credential).request(...task.sefin.operation)
      : summarizeSefinProductionNote(await getSefinProductionNote(credential, task.sefin.accessKey), task.sefin.accessKey, credential.cnpj);
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
