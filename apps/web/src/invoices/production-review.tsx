import { useState, type FormEvent } from "react";
import { civilDateLabel } from "../format";
import { errorMessage, jsonMutation, RegistrationError, type useRegistrationRequest } from "../registrations/api";

type Transmission = "BLOCKED" | "RELEASED" | "PENDING" | "REJECTED" | "AUTHORIZED";
type Details = {
  series: string; number: string; competence: string; customerName: string; customerDocument: string;
  amount: string; description: string; serviceCode: string; municipalServiceCode: string;
  taxRegime?: string; simplesAssessment?: string; specialRegime?: string; simplesTotal?: string; issRetention: string;
};
export type ProductionReview = { sha256: string; details: Details; transmission: Transmission; codes: string[] };
type Result = { transmission: Transmission; codes: string[] };
const statusText: Record<Transmission, string> = {
  BLOCKED: "Envio bloqueado até a autorização desta DPS",
  RELEASED: "DPS liberada para confirmação de envio",
  PENDING: "Envio registrado. Aguardando confirmação da SEFIN",
  REJECTED: "DPS rejeitada pela SEFIN",
  AUTHORIZED: "NFS-e autorizada em produção",
};
const errors: Record<string, string> = {
  "production-transmission-blocked": "O envio desta DPS está bloqueado no servidor.",
  "draft-changed": "Os dados do rascunho mudaram. Prepare uma nova DPS antes de solicitar autorização.",
  "valid-certificate-required": "Confira o A1 atual da empresa antes de continuar.",
  "sefin-unreachable": "A SEFIN não respondeu. Consulte a situação antes de qualquer nova tentativa.",
  "invalid-response": "A SEFIN retornou um formato inesperado. Se a nota aparecer no portal, consulte pela chave.",
  "response-mismatch": "O XML retornado diverge da DPS em revisão.",
  "homologation-busy": "Há outra operação fiscal em andamento. Tente novamente em instantes.",
};

export function ProductionDpsReview({ draftPath, idDps, sha256, details, transmission, codes, current, request }:
  ProductionReview & { draftPath: string; idDps: string; current: boolean; request: ReturnType<typeof useRegistrationRequest> }) {
  const [result, setResult] = useState<Result>({ transmission, codes });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const path = draftPath + "/" + encodeURIComponent(idDps);
  const amount = Number(details.amount).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  async function run(action: "submit" | "reconcile", accessKey?: string) {
    if (busy) return;
    setBusy(true);
    setConfirm(false);
    setError("");
    const payload: Record<string, string | boolean> = action === "submit" ? { confirmProduction: true } : accessKey ? { accessKey } : {};
    try {
      setResult(await request<Result>(path + "/" + action, jsonMutation("POST", payload)));
    } catch (failure) {
      if (action === "submit") {
        const latest = await request<{ prepared: Result & { idDps: string } | null }>(draftPath).catch(() => undefined);
        if (latest?.prepared?.idDps === idDps) setResult(latest.prepared);
      }
      setError(failure instanceof RegistrationError && failure.code && Object.hasOwn(errors, failure.code)
        ? errors[failure.code] : errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  function reconcileByKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = String(new FormData(event.currentTarget).get("accessKey") ?? "").trim().toUpperCase();
    if (key) void run("reconcile", key);
  }

  return <section className="registry-card">
    <h3>DPS de produção assinada</h3>
    <p role="status"><strong>{statusText[result.transmission]}</strong></p>
    {!current && result.transmission !== "PENDING" && <p>O rascunho ou o certificado mudou desde a assinatura.</p>}
    {error && <p className="registry-error" role="alert">{error}</p>}
    {result.codes.length > 0 && <p>Códigos da SEFIN {result.codes.join(", ")}</p>}
    <dl className="record-details">
      <div><dt>Tomador</dt><dd>{details.customerName} · {details.customerDocument}</dd></div>
      <div><dt>Serviço</dt><dd>{details.description} · {details.serviceCode}{details.municipalServiceCode && " / " + details.municipalServiceCode}</dd></div>
      <div><dt>Valor</dt><dd>{amount}</dd></div>
      <div><dt>Competência</dt><dd>{civilDateLabel(details.competence)}</dd></div>
      <div><dt>Série e número</dt><dd>{details.series} / {details.number}</dd></div>
      <div><dt>Simples Nacional</dt><dd>{details.taxRegime === "3" ? "ME/EPP optante" : details.taxRegime === "2" ? "MEI" : "Não optante"}
        {details.simplesAssessment && " · Código de apuração " + details.simplesAssessment}
        {details.simplesTotal && " · Tributos aproximados " + details.simplesTotal + "%"}</dd></div>
      <div><dt>Regime especial</dt><dd>{details.specialRegime === "0" ? "Nenhum" : details.specialRegime}</dd></div>
      <div><dt>Retenção de ISSQN</dt><dd>{details.issRetention === "2" ? "Pelo tomador" : "Sem retenção"}</dd></div>
      <div><dt>Identificador da DPS</dt><dd><code className="invoice-access-key">{idDps}</code></dd></div>
      <div><dt>Hash da DPS para autorização</dt><dd><code className="invoice-access-key">{sha256}</code></dd></div>
    </dl>
    {result.transmission === "RELEASED" && current && <div className="record-actions">
      {confirm ? <>
        <p>Confirme a emissão com valor fiscal para {details.customerName} no valor de {amount}.</p>
        <button className="button-danger" type="button" disabled={busy} onClick={() => void run("submit")}>Confirmar emissão real</button>
        <button className="button-secondary" type="button" onClick={() => setConfirm(false)}>Cancelar</button>
      </> : <button type="button" disabled={busy} onClick={() => setConfirm(true)}>Revisar envio em produção</button>}
    </div>}
    {result.transmission === "PENDING" && <>
      <button type="button" disabled={busy} onClick={() => void run("reconcile")}>{busy ? "Consultando…" : "Consultar situação na SEFIN"}</button>
      <details>
        <summary>Consultar pela chave de acesso</summary>
        <form className="record-form" onSubmit={reconcileByKey}>
          <label>Chave da NFS-e de produção<input name="accessKey" maxLength={50} pattern="[0-9A-Za-z]{50}" required disabled={busy} /></label>
          <button disabled={busy}>Recuperar nota existente</button>
        </form>
      </details>
    </>}
    {result.transmission === "AUTHORIZED" && <p>O XML e a chave estão disponíveis no histórico do cliente.</p>}
  </section>;
}
