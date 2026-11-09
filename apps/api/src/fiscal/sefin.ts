import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "zod";
import { accessKeyPattern, dpsIdPattern, validateDps, validateReturnedNfse } from "./documents.ts";
import { FiscalError, maxXmlBytes } from "./errors.ts";
import type { SubmissionLedger } from "./ledger.ts";
import type { SefinResponse, SefinTransport } from "./sefin-transport.ts";

const processingDate = z.iso.datetime({ offset: true });
const envelope = z.object({
  tipoAmbiente: z.literal(2),
  versaoAplicativo: z.string().min(1).max(200),
  dataHoraProcessamento: processingDate,
});
const key = z.string().length(50).regex(accessKeyPattern);
const dpsId = z.string().length(45).regex(dpsIdPattern);
const compressed = z.string().min(1).max(3 * 1024 * 1024).pipe(z.base64());
const lookupSuccess = envelope.extend({ idDps: dpsId, chaveAcesso: key });
const lookupMissing = envelope.extend({ erro: z.object({}) });
// SEFIN also returns this abbreviated envelope before a DPS has a corresponding NFS-e.
const lookupMissingE2404 = z.strictObject({
  tipoAmbiente: z.literal(0),
  dataHoraProcessamento: processingDate,
  erro: z.object({ codigo: z.literal("E2404") }),
});
const noteSuccess = envelope.extend({ chaveAcesso: key, nfseXmlGZipB64: compressed });
const submissionSuccess = noteSuccess.extend({ idDps: dpsId });
const errorCode = z.string().regex(/^[A-Z0-9_-]{1,24}$/);
const rejection = envelope.extend({
  erros: z.array(z.object({ codigo: z.string().optional(), Codigo: z.string().optional() })).min(1).max(100),
});

export type FiscalNote = ReturnType<typeof validateReturnedNfse>;
export type Submission =
  | { state: "authorized" | "reconciled"; note: FiscalNote }
  | { state: "rejected"; id: string; codes: string[]; processadoEm: string }
  | { state: "indeterminate"; id: string };

function unexpected() {
  return new FiscalError("invalid-response", "A resposta da SEFIN diverge do contrato de homologação.");
}

const lookupFields = [
  "tipoAmbiente", "versaoAplicativo", "dataHoraProcessamento", "idDps", "idDPS", "chaveAcesso",
  "erro", "erros", "Erro", "Erros", "codigo", "Codigo", "status", "title", "detail", "message",
];
const reportedEnvironments = new Set<unknown>([0, 1, 2, "0", "1", "2"]);

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function unexpectedLookup(response: SefinResponse, id: string, issues: readonly z.core.$ZodIssue[] = []) {
  const data = record(response.body);
  const environment = data.tipoAmbiente;
  const returnedId = data.idDps ?? data.idDPS;
  const multiple = data.erros ?? data.Erros;
  const entries = [data, record(data.erro ?? data.Erro)];
  if (Array.isArray(multiple)) entries.push(...multiple.slice(0, 10).map(record));
  const codes = entries.map((entry) => entry.codigo ?? entry.Codigo)
    .filter((code) => typeof code === "string" && /^[A-Z]{1,4}[0-9]{3,6}$/.test(code));
  return new FiscalError("invalid-response", "A consulta da DPS retornou um formato diferente do esperado.", {
    operacao: "consultar-dps",
    httpStatus: response.status,
    formato: response.format ?? (response.body === undefined ? "empty" : "json"),
    campos: lookupFields.filter((field) => Object.hasOwn(data, field)),
    camposInvalidos: [...new Set(issues.map(({ path }) => path[0]).filter((field) => typeof field === "string" && lookupFields.includes(field)))],
    tipoAmbiente: reportedEnvironments.has(environment) ? environment : undefined,
    idDps: returnedId === undefined ? "ausente" : returnedId === id ? "corresponde" : "diverge",
    codigos: [...new Set(codes)],
  });
}

function httpError(status: number) {
  return new FiscalError("sefin-http", `A SEFIN de homologação respondeu HTTP ${status}.`);
}

function readNote(payload: z.infer<typeof noteSuccess>, expectedKey: string, expectedDps?: string) {
  if (payload.chaveAcesso !== expectedKey) throw unexpected();
  let xml: Buffer;
  try {
    xml = gunzipSync(Buffer.from(payload.nfseXmlGZipB64, "base64"), { maxOutputLength: maxXmlBytes });
  } catch {
    throw unexpected();
  }
  return validateReturnedNfse(xml, expectedKey, expectedDps);
}

export function createSefinHomologation(transport: SefinTransport, ledger: SubmissionLedger) {
  async function lookup(id: string) {
    if (!dpsId.safeParse(id).success) throw new FiscalError("invalid-dps-id", "Informe o Id completo da DPS.");
    const response = await transport.request("GET", `/dps/${id}`);
    if (response.status === 404) {
      const result = lookupMissing.safeParse(response.body);
      if (!result.success && !lookupMissingE2404.safeParse(response.body).success) {
        throw unexpectedLookup(response, id, result.error.issues);
      }
      return null;
    }
    if (response.status !== 200) throw httpError(response.status);
    const result = lookupSuccess.safeParse(response.body);
    if (!result.success) throw unexpectedLookup(response, id, result.error.issues);
    if (result.data.idDps !== id) throw unexpectedLookup(response, id);
    return { id, accessKey: result.data.chaveAcesso };
  }

  async function getNote(accessKey: string, expectedDps?: string) {
    if (!key.safeParse(accessKey).success) throw new FiscalError("invalid-access-key", "Informe a chave de acesso de 50 posições.");
    const response = await transport.request("GET", `/nfse/${accessKey}`);
    if (response.status !== 200) throw httpError(response.status);
    const result = noteSuccess.safeParse(response.body);
    if (!result.success) throw unexpected();
    return readNote(result.data, accessKey, expectedDps);
  }

  async function submit(xml: Buffer): Promise<Submission> {
    // Keep the validated bytes stable across asynchronous reconciliation calls.
    if (xml.length > maxXmlBytes) throw new FiscalError("invalid-xml", "O XML excede o limite permitido.");
    const document = Buffer.from(xml);
    const { id, cnpj, fingerprint } = validateDps(document);
    if (transport.identity.cnpj !== cnpj || transport.identity.fingerprint !== fingerprint) {
      throw new FiscalError("certificate-holder-mismatch", "O A1 da conexão deve ser o mesmo certificado que assinou a DPS do prestador.");
    }
    const documentHash = createHash("sha256").update(document).digest("hex");
    const previous = await ledger.check(id, documentHash);
    const existing = await lookup(id);
    if (existing) {
      const note = await getNote(existing.accessKey, id);
      if (previous) await ledger.finish(id, "reconciled");
      return { state: "reconciled", note };
    }
    if (previous) return { state: "indeterminate", id };
    if (await ledger.claim(id, documentHash) === "previous-attempt") return { state: "indeterminate", id };

    let result: Submission = { state: "indeterminate", id };
    let rejected: Extract<Submission, { state: "rejected" }> | undefined;
    try {
      const response = await transport.request("POST", "/nfse", { dpsXmlGZipB64: gzipSync(document).toString("base64") });
      if (response.status === 201) {
        const data = submissionSuccess.safeParse(response.body);
        if (data.success && data.data.idDps === id) {
          result = { state: "authorized", note: readNote(data.data, data.data.chaveAcesso, id) };
        }
      } else if (response.status === 400 || response.status === 403) {
        const data = rejection.safeParse(response.body);
        if (data.success) {
          const codes = data.data.erros.flatMap((entry) => {
            const code = errorCode.safeParse(entry.codigo ?? entry.Codigo);
            return code.success ? [code.data] : [];
          });
          rejected = { state: "rejected", id, codes, processadoEm: data.data.dataHoraProcessamento };
        }
      }
    } catch {
      // A transport error can occur after the server has received the DPS.
    }

    if (result.state === "indeterminate") {
      try {
        const resolved = await lookup(id);
        if (resolved) result = { state: "reconciled", note: await getNote(resolved.accessKey, id) };
        else if (rejected) result = rejected;
      } catch {
        // Keep the reservation and report uncertainty when reconciliation is inconclusive.
      }
    }
    await ledger.finish(id, result.state);
    return result;
  }

  return { lookup, getNote, submit };
}
