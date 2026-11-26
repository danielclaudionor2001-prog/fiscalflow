import { useEffect, useState } from "react";
import { civilDateLabel, timestampLabel } from "../format";
import { errorMessage, jsonMutation, RegistrationError, type useRegistrationRequest } from "../registrations/api";

export const automaticMessages: Record<string, string> = {
  "automatic-engine-unavailable": "A emissão automática ainda não está disponível nesta instalação.",
  "automatic-company-release-required": "A empresa precisa estar liberada para emissão em produção pelo Fiscal Floow.",
  "automatic-service-required": "Vincule um serviço do catálogo a esta programação.",
  "automatic-fiscal-data-required": "Confira e salve os dados fiscais desse cliente e serviço antes de ativar a emissão automática.",
  "automatic-certificate-renewal-required": "O certificado vence antes da próxima emissão. Renove o A1 antes de ativar.",
  "automatic-settings-changed": "A programação mudou. Feche e abra novamente esta revisão.",
  "automatic-owner-required": "O responsável que autorizou precisa continuar como proprietário da empresa.",
  "automatic-approval-changed": "Os dados da empresa, do cliente, do serviço ou da programação mudaram. Revise e autorize novamente.",
  "automatic-invoice-changed": "Os dados da nota foram alterados. Confira a nota antes de uma nova autorização.",
  "automatic-period-missed": "A execução ficou para um mês anterior. Revise a programação para continuar; nenhuma nota retroativa será enviada automaticamente.",
  "valid-certificate-required": "Confira se o A1 da empresa está cadastrado e dentro da validade.",
};
const money = (amount: string) => Number(amount).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
type Preview = {
  enabled: boolean; ready: boolean; version: string; reason?: string;
  customerName: string; amount: string; serviceDescription: string; nextRunAt?: string; competence: string | null;
  certificateValidUntil?: string;
  fiscalData?: { serie: string; cTribNac: string; cTribMun?: string; cNBS?: string; cLocPrestacao: string;
    opSimpNac: string; regApTribSN?: string; regEspTrib: string; tpRetISSQN: string; pAliq?: string;
    totTrib: { pTotTribSN?: string; pTotTrib?: { federal: string; estadual: string; municipal: string }; indTotTrib?: string } };
};

export function AutomaticSchedulePanel({ id, request, close, saved }: {
  id: string; request: ReturnType<typeof useRegistrationRequest>; close: () => void; saved: () => void;
}) {
  const [preview, setPreview] = useState<Preview>();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const path = "schedules/" + encodeURIComponent(id) + "/automatic-production";
  useEffect(() => {
    const controller = new AbortController();
    request<Preview>(path, { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) setPreview(value);
    }).catch((failure) => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [request, path]);
  async function save() {
    if (!preview || busy || (!preview.enabled && !confirm)) return;
    setBusy(true); setError("");
    try {
      await request(path, jsonMutation("PUT", { enabled: !preview.enabled, version: preview.version,
        ...(!preview.enabled && { confirmAutomaticProduction: true }) }));
      saved();
    } catch (failure) { setError(failure instanceof RegistrationError && failure.code && automaticMessages[failure.code]
      ? automaticMessages[failure.code] : errorMessage(failure)); }
    finally { setBusy(false); }
  }
  const fiscal = preview?.fiscalData;
  return <section className="registry-card automatic-schedule" aria-labelledby="automatic-schedule-title">
    <span className="asaas-badge">EMISSÃO MENSAL · PRODUÇÃO</span>
    <h2 id="automatic-schedule-title">{preview?.enabled ? "Emissão automática autorizada" : "Autorizar emissão automática"}</h2>
    <p>Todo dia 1, às 8h de Brasília, o Fiscal Floow assina e envia a NFS-e desta programação. A competência será o primeiro dia do mês da emissão.</p>
    {!preview && !error && <p role="status">Conferindo dados fiscais e certificado…</p>}
    {error && <p role="alert" className="registry-error">{error}</p>}
    {preview && <>
      <dl className="record-details">
        <div><dt>Cliente</dt><dd>{preview.customerName}</dd></div>
        <div><dt>Valor mensal</dt><dd>{money(preview.amount)}</dd></div>
        <div><dt>Serviço</dt><dd>{preview.serviceDescription}</dd></div>
        <div><dt>Próxima emissão</dt><dd>{preview.nextRunAt ? timestampLabel(preview.nextRunAt) : "Confira as pendências abaixo"}</dd></div>
        <div><dt>Próxima competência</dt><dd>{preview.competence ? civilDateLabel(preview.competence) : "—"}</dd></div>
        <div><dt>Validade do A1</dt><dd>{preview.certificateValidUntil ? timestampLabel(preview.certificateValidUntil) : "Indisponível"}</dd></div>
      </dl>
      {fiscal && <details><summary>Conferir os dados fiscais que serão reutilizados</summary>
        <dl className="record-details">
          <div><dt>Código nacional / municipal</dt><dd>{fiscal.cTribNac} / {fiscal.cTribMun ?? "Não informado"}</dd></div>
          <div><dt>NBS</dt><dd>{fiscal.cNBS ?? "Não informado"}</dd></div>
          <div><dt>Município da prestação (IBGE)</dt><dd>{fiscal.cLocPrestacao}</dd></div>
          <div><dt>Série do aplicativo</dt><dd>{fiscal.serie} · número reservado automaticamente por nota</dd></div>
          <div><dt>Simples Nacional</dt><dd>{fiscal.opSimpNac === "3" ? "ME/EPP optante" : fiscal.opSimpNac === "2" ? "MEI" : "Não optante"}{fiscal.regApTribSN && " · apuração " + fiscal.regApTribSN}</dd></div>
          <div><dt>Regime especial</dt><dd>{fiscal.regEspTrib === "0" ? "Nenhum" : fiscal.regEspTrib}</dd></div>
          <div><dt>Retenção de ISSQN</dt><dd>{fiscal.tpRetISSQN === "1" ? "Sem retenção" : "Pelo tomador"}{fiscal.pAliq && " · alíquota " + fiscal.pAliq + "%"}</dd></div>
          <div><dt>Tributos aproximados</dt><dd>{fiscal.totTrib.pTotTribSN ? "Simples Nacional: " + fiscal.totTrib.pTotTribSN + "%"
            : fiscal.totTrib.pTotTrib ? "Federal " + fiscal.totTrib.pTotTrib.federal + "% · Estadual " + fiscal.totTrib.pTotTrib.estadual + "% · Municipal " + fiscal.totTrib.pTotTrib.municipal + "%" : "Indicador de MEI"}</dd></div>
        </dl>
      </details>}
      {!preview.ready && <p className="registry-error" role="alert">{automaticMessages[preview.reason ?? ""] ?? "Confira os dados fiscais desta programação antes de ativar."}</p>}
      <p>A ativação agenda somente a próxima data futura. Nenhuma nota será enviada agora. Você pode pausar a programação; mudanças nos dados fiscais exigem uma nova autorização.</p>
      {!preview.enabled && <label className="checkbox-field"><input type="checkbox" checked={confirm} disabled={busy || !preview.ready} onChange={(e) => setConfirm(e.currentTarget.checked)} />
        Conferi cliente, serviço, valor e dados fiscais e autorizo as emissões mensais em produção, sem revisão a cada mês.</label>}
      <div className="record-actions"><button type="button" disabled={busy || (!preview.enabled && (!preview.ready || !confirm))} onClick={() => void save()}>
        {busy ? "Salvando…" : preview.enabled ? "Pausar emissão automática" : "Ativar para a próxima competência"}</button>
        <button type="button" className="button-secondary" disabled={busy} onClick={close}>Voltar</button></div>
    </>}
  </section>;
}
