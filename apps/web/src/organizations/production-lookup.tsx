import { useState, type FormEvent } from "react";
import { timestampLabel } from "../format";
import { errorMessage, jsonMutation, RegistrationError, type useRegistrationRequest } from "../registrations/api";

type NoteSummary = { number: string; status: string; processedAt: string };

const lookupErrors: Record<string, string> = {
  "production-lookup-denied": "A SEFIN de produção recusou a consulta com o A1 da empresa.",
  "production-note-not-found": "A SEFIN de produção não encontrou uma nota para esta chave.",
  "production-note-holder-mismatch": "Informe a chave de uma nota emitida por esta empresa.",
  "production-lookup-unavailable": "A API de produção não concluiu a consulta. Tente novamente em instantes.",
  "invalid-production-response": "A resposta da SEFIN não confirmou a nota informada.",
  "sefin-unreachable": "Não foi possível conectar à API de produção da SEFIN com este certificado.",
  "valid-certificate-required": "Cadastre um A1 válido da empresa para consultar.",
  "homologation-busy": "Há outra consulta fiscal em andamento. Tente novamente em instantes.",
};

export function ProductionNoteLookup({ request }: { request: ReturnType<typeof useRegistrationRequest> }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<NoteSummary>();
  const [error, setError] = useState("");

  async function consult(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const key = String(new FormData(event.currentTarget).get("accessKey") ?? "").trim().toUpperCase();
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      setResult(await request<NoteSummary>("certificates/production-lookup", jsonMutation("POST", { accessKey: key })));
    } catch (failure) {
      setError(failure instanceof RegistrationError && failure.code && Object.hasOwn(lookupErrors, failure.code)
        ? lookupErrors[failure.code] : errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return <section className="registry-card">
    <h2>Consultar NFS-e em produção</h2>
    <p>Use o A1 cadastrado para localizar uma nota já emitida por esta empresa.</p>
    <form className="record-form" onSubmit={consult}>
      <label>Chave de acesso da NFS-e
        <input name="accessKey" pattern="[0-9A-Za-z]{50}" maxLength={50} autoComplete="off" required disabled={busy} />
      </label>
      <div className="record-actions"><button disabled={busy}>{busy ? "Consultando…" : "Consultar nota existente"}</button></div>
    </form>
    {error && <p className="registry-error" role="alert">{error}</p>}
    {result && <div role="status">
      <p><strong>NFS-e nº {result.number} encontrada na API de produção.</strong></p>
      <dl className="record-details">
        <div><dt>Situação no XML</dt><dd>{result.status === "100" ? "100 · NFS-e gerada" : result.status}</dd></div>
        <div><dt>Data de geração</dt><dd>{timestampLabel(result.processedAt)}</dd></div>
      </dl>
    </div>}
  </section>;
}
