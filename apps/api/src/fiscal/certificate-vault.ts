import { createCipheriv, createDecipheriv, createSecretKey, randomBytes, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { RequestError } from "../http.ts";
import type { CertificateTask } from "./certificate-worker.ts";

const nonceBytes = 12;
const tagBytes = 16;
const nonceEnd = nonceBytes + tagBytes;
type Binding = { organizationId: string; version: string };
type TaskResult = {
  fingerprint: string; validFrom: Date; validUntil: Date;
  signed?: { id: string; xml: Uint8Array };
};

let workerActive = false;

async function runTask(task: CertificateTask) {
  if (workerActive) throw new RequestError(429, "certificate-busy");
  const file = import.meta.url.endsWith(".ts") ? "./certificate-worker.ts" : "./certificate-worker.js";
  const worker = new Worker(new URL(file, import.meta.url), {
    workerData: task, execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 4 },
  });
  workerActive = true;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<TaskResult>((resolve, reject) => {
      worker.once("message", ({ result, error }: { result?: TaskResult; error?: string }) => {
        if (result) resolve(result);
        else reject(new RequestError(422, error ?? "invalid-certificate"));
      });
      const fail = () => reject(new RequestError(422, "certificate-processing-failed"));
      worker.once("error", fail);
      worker.once("exit", fail);
      timer = setTimeout(fail, 10_000);
    });
  } finally {
    clearTimeout(timer);
    try { await worker.terminate(); } finally { workerActive = false; }
  }
}

function aad({ organizationId, version }: Binding) {
  return Buffer.from(JSON.stringify(["fiscalflow-certificate-v1", organizationId, version]), "utf8");
}

function parseCertificateBundle(bundle: string, limit: number) {
  const pattern = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
  const certificates = bundle.match(pattern) ?? [];
  if (!certificates.length || certificates.length > limit || bundle.replace(pattern, "").trim()) {
    throw new Error("Invalid certificate bundle.");
  }
  return certificates;
}

export function createCertificateVault(keyValue: string, rootBundle: string, intermediateBundle?: string) {
  const bytes = Buffer.from(keyValue, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== keyValue) {
    bytes.fill(0);
    throw new Error("Invalid certificate vault key.");
  }
  const key = createSecretKey(bytes);
  bytes.fill(0);

  const roots = parseCertificateBundle(rootBundle, 24);
  for (const pem of roots) {
    const root = new X509Certificate(pem);
    if (!root.ca || !root.checkIssued(root) || !root.verify(root.publicKey)) {
      throw new Error("The certificate root bundle must only contain trusted roots.");
    }
  }
  const intermediates = intermediateBundle === undefined ? [] : parseCertificateBundle(intermediateBundle, 64);
  for (const pem of intermediates) {
    const cert = new X509Certificate(pem);
    if (!cert.ca || (cert.checkIssued(cert) && cert.verify(cert.publicKey))) {
      throw new Error("The intermediate bundle must only contain intermediate CA certificates.");
    }
  }

  return {
    inspect(pfx: Buffer, passphrase: string, cnpj: string) {
      return runTask({ pfx, passphrase, roots, intermediates, cnpj });
    },

    seal(binding: Binding, pfx: Buffer, passphrase: string) {
      const password = Buffer.from(passphrase, "utf8");
      try {
        const length = Buffer.alloc(2);
        length.writeUInt16BE(password.length);
        const nonce = randomBytes(nonceBytes);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(aad(binding));
        const ciphertext = [cipher.update(length), cipher.update(password), cipher.update(pfx), cipher.final()];
        return Buffer.concat([nonce, cipher.getAuthTag(), ...ciphertext]);
      } finally {
        password.fill(0);
      }
    },

    async sign(binding: Binding, sealed: Uint8Array, cnpj: string, unsigned: Buffer) {
      let payload: Buffer | undefined;
      let partial: Buffer | undefined;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, nonceBytes));
        decipher.setAAD(aad(binding));
        decipher.setAuthTag(sealed.subarray(nonceBytes, nonceEnd));
        partial = decipher.update(sealed.subarray(nonceEnd));
        payload = Buffer.concat([partial, decipher.final()]);
        const passwordEnd = 2 + payload.readUInt16BE();
        if (passwordEnd <= 2 || passwordEnd >= payload.length) throw new Error("Invalid vault payload.");
        const passphrase = payload.toString("utf8", 2, passwordEnd);
        return await runTask({ pfx: payload.subarray(passwordEnd), passphrase, roots, intermediates, cnpj, unsigned });
      } catch (error) {
        if (error instanceof RequestError) throw error;
        throw new RequestError(503, "certificate-unavailable");
      } finally {
        partial?.fill(0);
        payload?.fill(0);
      }
    },
  };
}

export type CertificateVault = ReturnType<typeof createCertificateVault>;

export function configureCertificateVault(key?: string, rootsFile?: string, intermediatesFile?: string) {
  if (!key && !rootsFile && !intermediatesFile) return undefined;
  if (!key || !rootsFile) throw new Error("Incomplete certificate vault configuration.");
  return createCertificateVault(
    key,
    readFileSync(rootsFile, "utf8"),
    intermediatesFile ? readFileSync(intermediatesFile, "utf8") : undefined,
  );
}
