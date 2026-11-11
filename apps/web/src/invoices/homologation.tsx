import { useState } from "react";
import { errorMessage, jsonMutation, RegistrationError, type useRegistrationRequest } from "../registrations/api";

export type HomologationResult = {
  idDps: string;
  status: "READY" | "PENDING" | "REJECTED" | "AUTHORIZED";
  accessKey: string | null;
  codes: string[];
  updatedAt: string | null;
};

const labels: Record<HomologationResult["status"], string> = {
  READY: "Pronta para envio de teste",
  PENDING: "Aguardando consulta à SEFIN",
  REJECTED: "DPS de teste rejeitada",
  AUTHORIZED: "NFS-e de teste autorizada",
};

const errors: Record<string, string> = {
  "draft-changed": "Abra a versão atual do rascunho e prepare uma nova DPS de teste.",
  "homologation-certificate-changed": "Prepare outra DPS de teste com o certificado atual da empresa.",
  "valid-certificate-required": "Cadastre um e-CNPJ A1 válido da empresa para continuar.",
  "certificate-chain-untrusted": "Confira a cadeia do A1 cadastrado em Empresa → Certificados.",
  "certificate-unavailable": "O cofre de certificados está indisponível.",
  "homologation-busy": "Há um teste em andamento ou o limite de consultas foi atingido. Tente novamente em instantes.",
  "sefin-unreachable": "A SEFIN de testes está indisponível. Confira a situação antes de tentar outro envio.",
  "invalid-response": "A SEFIN retornou um formato inesperado. Confira a situação da DPS de teste.",
  "response-mismatch": "A SEFIN devolveu uma nota com dados diferentes da DPS preparada. Confira a numeração de teste.",
  "dps-unavailable": "A DPS de teste não está disponível neste rascunho.",
};

export function HomologationCard({ draftPath, dpsId, current, previous, request }: {
  draftPath: string;
  dpsId: string;
  current: boolean;
  previous?: HomologationResult;
  request: ReturnType<typeof useRegistrationRequest>;
}) {
  const [result, setResult] = useState(previous);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const status = result?.status ?? "READY";
  const path = draftPath + "/" + encodeURIComponent(dpsId) + "/homologation";
  if (status === "READY" && !current) return null;

  async function run(reconcile: boolean) {
    if (busy) return;
    setBusy(true);
    setConfirm(false);
    setError("");
    try {
      const next = await request<HomologationResult>(
        reconcile ? path + "/reconcile" : path,
        reconcile ? { method: "POST" } : jsonMutation("POST", { confirmTest: true }),
      );
      setResult(next);
    } catch (failure) {
      const latest = await request<HomologationResult>(path).catch(() => undefined);
      if (latest) setResult(latest);
      if (!latest || latest.status === status) {
        setError(failure instanceof RegistrationError && failure.code && Object.hasOwn(errors, failure.code)
          ? errors[failure.code] : errorMessage(failure));
      }
    } finally {
      setBusy(false);
    }
  }

  return <section className="registry-card">
    <h3>Homologação da DPS</h3>
    <p>Produção restrita · Sem valor fiscal</p>
    <p role="status"><strong>{labels[status]}</strong> · <code>{dpsId}</code></p>
    {error && <p className="registry-error" role="alert">{error}</p>}
    {status === "REJECTED" && <p>{result?.codes.length ? `Códigos da SEFIN: ${result.codes.join(", ")}. ` : ""}
      Revise os dados e prepare uma DPS com um novo número de teste.</p>}
    {status === "PENDING" && <p>Use a consulta para recuperar o resultado desta tentativa.</p>}
    {status === "AUTHORIZED" && result?.accessKey && <p>Chave de teste <code>{result.accessKey}</code></p>}
    {confirm && <p>Confirme o envio desta DPS à SEFIN em produção restrita.</p>}
    <div className="record-actions">
      {status === "READY" && !confirm && <button type="button" disabled={busy} onClick={() => setConfirm(true)}>
        {busy ? "Enviando DPS de teste…" : "Enviar DPS de teste"}
      </button>}
      {confirm && <>
        <button type="button" onClick={() => void run(false)}>Confirmar envio de teste</button>
        <button type="button" className="button-secondary" onClick={() => setConfirm(false)}>Cancelar</button>
      </>}
      {status === "PENDING" && <button type="button" disabled={busy} onClick={() => void run(true)}>
        {busy ? "Consultando…" : "Consultar teste na SEFIN"}
      </button>}
      {status === "AUTHORIZED" && <a href={"/api/" + path + "/xml"} download>Baixar XML da NFS-e de teste</a>}
    </div>
  </section>;
}
