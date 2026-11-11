import { Agent, request } from "node:https";
import type { HomologationCredential, CertificateIdentity } from "./certificate.ts";
import { accessKeyPattern, dpsIdPattern } from "./documents.ts";
import { FiscalError } from "./errors.ts";

const homologationHostname = "sefin.producaorestrita.nfse.gov.br";
const productionHostname = "sefin.nfse.gov.br";
const basePath = "/SefinNacional";
export const sefinHomologationEndpoint = `https://${homologationHostname}${basePath}`;
export const sefinProductionEndpoint = `https://${productionHostname}${basePath}`;
const maxResponseBytes = 4 * 1024 * 1024;

export interface SefinTransport {
  identity: CertificateIdentity;
  request(method: "GET" | "POST", path: string, body?: { dpsXmlGZipB64: string }): Promise<SefinResponse>;
}

export type SefinResponse = {
  status: number;
  body: unknown;
  format?: "json" | "invalid-json" | "non-json" | "empty";
};

function assertOperation(method: "GET" | "POST", path: string, hasBody: boolean) {
  const consultation = (path.length === 50 && path.startsWith("/dps/") && dpsIdPattern.test(path.slice(5))) ||
    (path.length === 56 && path.startsWith("/nfse/") && accessKeyPattern.test(path.slice(6)));
  const valid = (method === "POST" && path === "/nfse" && hasBody) || (method === "GET" && consultation && !hasBody);
  if (!valid) throw new FiscalError("invalid-operation", "Operação fora do contrato de homologação.");
}

function requestError() {
  return new FiscalError("sefin-unreachable", "A conexão com a SEFIN falhou ou excedeu o limite.");
}

function requestSefin(
  hostname: typeof homologationHostname | typeof productionHostname,
  credential: HomologationCredential,
  method: "GET" | "POST",
  path: string,
  data?: string,
): Promise<SefinResponse> {
  if (hostname === productionHostname && (method !== "GET" || data !== undefined)) {
    throw new FiscalError("invalid-operation", "A conexão de produção é exclusiva para consulta.");
  }
  const agent = new Agent({ secureContext: credential.secureContext, keepAlive: false, maxCachedSessions: 0 });
  return new Promise<SefinResponse>((resolve, reject) => {
    const req = request({
      hostname,
      servername: hostname,
      protocol: "https:",
      port: 443,
      path: basePath + path,
      method,
      rejectUnauthorized: true,
      agent,
      signal: AbortSignal.timeout(20_000),
      headers: {
        Accept: "application/json",
        ...(data && { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }),
      },
    }, (res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of res) {
          const buffer = Buffer.from(chunk);
          length += buffer.length;
          if (length > maxResponseBytes) {
            res.destroy();
            throw requestError();
          }
          chunks.push(buffer);
        }
        let body: unknown;
        let format: SefinResponse["format"] = length === 0 ? "empty" : "non-json";
        if (length > 0 && /^application\/(?:json|[\w.-]+\+json)(?:;|$)/i.test(res.headers["content-type"] ?? "")) {
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            format = "json";
          } catch {
            format = "invalid-json";
          }
        }
        resolve({ status: res.statusCode ?? 0, body, format });
      })().catch(() => reject(requestError()));
    });
    req.on("error", () => reject(requestError()));
    req.end(data);
  }).finally(() => agent.destroy());
}

export function sefinTransport(credential: HomologationCredential): SefinTransport {
  return {
    identity: { cnpj: credential.cnpj, fingerprint: credential.fingerprint },
    async request(method, path, payload) {
      assertOperation(method, path, payload !== undefined);
      return requestSefin(homologationHostname, credential, method, path, payload === undefined ? undefined : JSON.stringify(payload));
    },
  };
}

export async function getSefinProductionNote(credential: HomologationCredential, accessKey: string) {
  if (!accessKeyPattern.test(accessKey) || accessKey.slice(9, 23) !== credential.cnpj) {
    throw new FiscalError("production-note-holder-mismatch", "Informe uma chave de NFS-e emitida pelo CNPJ do A1.");
  }
  return requestSefin(productionHostname, credential, "GET", `/nfse/${accessKey}`);
}
