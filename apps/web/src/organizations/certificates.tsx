import { timestampLabel } from "../format";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { errorMessage, RegistrationError, useRegistrationRequest, type PageAccess } from "../registrations/api";
import { ProductionNoteLookup } from "./production-lookup";
import { Icon } from "../ui";
import { CertificateExpiryNotice, notifyCertificateChanged, useCertificateClock } from "./certificate-expiry";
import { certificateValidity } from "./certificate-status";

type Status = {
  enabled: boolean;
  productionLookupEnabled?: boolean;
  certificate: { version: string; validFrom: string; validUntil: string; savedAt: string; expired: boolean } | null;
};

const maxBytes = 1024 * 1024;

const errors: Record<string, string> = {
  "issuer-cnpj-required": "O cadastro de e-CNPJ A1 está disponível para contas com CNPJ.",
  "pfx-unlock-failed": "A senha não desbloqueou o arquivo. Confira a senha do A1.",
  "invalid-certificate": "Confira se o arquivo contém um e-CNPJ A1 válido para assinatura e autenticação.",
  "certificate-holder-mismatch": "O CNPJ do certificado deve ser o mesmo da empresa aberta no painel.",
  "certificate-chain-untrusted": "A cadeia do certificado não pôde ser validada. Confira se o arquivo inclui os certificados intermediários.",
  "certificate-unavailable": "O cofre de certificados precisa ser configurado na API.",
  "certificate-changed": "Outro acesso alterou o certificado. Recarregue a situação antes de continuar.",
  "certificate-busy": "Há outra validação em andamento. Tente novamente em alguns segundos.",
  "certificate-processing-failed": "A validação do arquivo não terminou. Confira o arquivo e tente novamente.",
  "secure-connection-required": "Abra o painel em uma conexão segura para cadastrar o certificado.",
};

function message(error: unknown) {
  if (error instanceof RegistrationError && error.code && Object.hasOwn(errors, error.code)) return errors[error.code];
  return errorMessage(error);
}

function fileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result.slice(reader.result.indexOf(",") + 1));
      else reject(new Error("Unreadable certificate."));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function CertificatesPage({ organizationId, role, endSession }: PageAccess) {
  const request = useRegistrationRequest(organizationId, endSession);
  const [status, setStatus] = useState<Status>();
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const certificate = status?.certificate;
  const now = useCertificateClock();
  const validity = certificate && certificateValidity(certificate.validUntil, now, certificate.validFrom);
  const uploadForm = useRef<HTMLFormElement>(null);
  const loadedAt = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    loadedAt.current = Date.now();
    request<Status>("certificates", { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setStatus(result); })
      .catch((failure) => { if (!controller.signal.aborted) setError(message(failure)); });
    return () => controller.abort();
  }, [request, reload]);

  useEffect(() => {
    if (busy) return;
    const refresh = () => { if (!document.hidden && Date.now() - loadedAt.current >= 30_000) setReload((value) => value + 1); };
    const timer = window.setInterval(refresh, 5 * 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [busy]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !status?.enabled) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const file = fields.get("file");
    const password = fields.get("password");
    const passwordInput = form.elements.namedItem("password");
    if (passwordInput instanceof HTMLInputElement) passwordInput.value = "";
    if (!(file instanceof File) || !file.size || file.size > maxBytes || typeof password !== "string" || !password) {
      setError("Selecione um arquivo A1 de até 1 MB e informe a senha.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const pfx = await fileBase64(file);
      const saved = await request<Status>("certificates", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "If-Match": '"' + (certificate?.version ?? "missing") + '"' },
        body: JSON.stringify({ pfx, password }),
      });
      form.reset();
      setStatus(saved);
      setReload((value) => value + 1);
      notifyCertificateChanged(organizationId);
      setNotice(certificate ? "Certificado substituído." : "Certificado cadastrado.");
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!certificate || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request("certificates", { method: "DELETE", headers: { "If-Match": '"' + certificate.version + '"' } });
      setStatus((current) => current && { ...current, certificate: null });
      setReload((value) => value + 1);
      notifyCertificateChanged(organizationId);
      setConfirm(false);
      setNotice("Certificado removido do Fiscal Floow.");
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="registry certificates-page">
      {error && <p className="registry-error" role="alert">{error}</p>}
      {notice && <p className="registry-notice" role="status">{notice}</p>}
      {certificate && <CertificateExpiryNotice certificate={certificate} now={now} showLink={false} />}
      <section className={"registry-card certificate-summary certificate-state-" + (validity?.kind ?? "missing")}>
        <div className="certificate-summary-heading"><div className="certificate-summary-title"><span className="certificate-large-icon"><Icon name="shield" /></span><div><span className="certificate-eyebrow">IDENTIDADE DIGITAL DA EMPRESA</span><h2>Certificado e-CNPJ A1</h2><p>Confira a validade e gerencie o certificado da sua empresa.</p></div></div>
          {certificate && <span className="certificate-state-badge">{validity?.kind === "expired" ? "Vencido" : validity?.kind === "urgent" ? "Renovação urgente" : validity?.kind === "expiring" ? "Próximo do vencimento" : validity?.kind === "upcoming" ? "Validade futura" : validity ? "Dentro da validade" : "Conferir validade"}</span>}
        </div>
        {!status && !error && <p role="status">Carregando certificado…</p>}
        {error && <button type="button" className="button-secondary" disabled={busy} onClick={() => {
          setError(""); setConfirm(false); setReload((current) => current + 1);
        }}>Recarregar situação</button>}
        {status && (certificate ? (
          <dl className="certificate-facts">
            <div><dt>Válido até</dt><dd>{validity ? timestampLabel(certificate.validUntil) : "Conferir data"}</dd></div>
            <div><dt>Tempo restante</dt><dd>{validity ? validity.kind === "expired" ? "Validade encerrada" : `${validity.days} ${validity.days === 1 ? "dia" : "dias"}` : "Indisponível"}</dd></div>
            <div><dt>Cadastrado no sistema</dt><dd>{timestampLabel(certificate.savedAt)}</dd></div>
          </dl>
        ) : <p>Esta empresa ainda não tem certificado cadastrado.</p>)}
        {status && !status.enabled && <p>O cadastro de certificados está indisponível até a configuração do cofre na API.</p>}
        <div className="certificate-renewal-info"><span><Icon name="bell" /></span><div><strong>Aviso de vencimento no Fiscal Floow</strong><p>O alerta aparece a partir de 30 dias antes do vencimento, com destaque maior nos últimos 7 dias e quando o certificado vence.</p><small>A validade é conferida novamente ao voltar à aba e enquanto o sistema estiver aberto.</small></div></div>
        {certificate && status?.enabled && role === "OWNER" && !confirm && <button type="button" className="certificate-renew-button" onClick={() => uploadForm.current?.scrollIntoView({ block: "start" })}><Icon name="key" />Renovar ou substituir A1</button>}
        {certificate && role === "OWNER" && (
          confirm ? <div className="archive-confirmation">
            <p>Remover o certificado cadastrado nesta empresa?</p>
            <div className="record-actions">
              <button type="button" className="button-danger" disabled={busy} onClick={() => void remove()}>Confirmar remoção</button>
              <button type="button" className="button-secondary" disabled={busy} onClick={() => setConfirm(false)}>Cancelar</button>
            </div>
          </div> : <button type="button" className="button-secondary" disabled={busy} onClick={() => setConfirm(true)}>Remover certificado</button>
        )}
      </section>
      {status?.productionLookupEnabled && certificate && validity && !["expired", "upcoming"].includes(validity.kind) && !certificate.expired && role === "OWNER" &&
        <ProductionNoteLookup key={certificate.version} request={request} />}
      {status?.enabled && role === "OWNER" && !confirm && (
        <form ref={uploadForm} className="record-form registry-card certificate-upload" onSubmit={upload}>
          <h2>{certificate ? "Substituir certificado" : "Cadastrar certificado"}</h2>
          <p>Selecione o arquivo A1 da empresa e informe a senha para validar e salvar.</p>
          <label>Arquivo A1 (.pfx ou .p12)
            <input type="file" name="file" accept=".pfx,.p12" required disabled={busy} />
          </label>
          <label>Senha do arquivo
            <input type="password" name="password" autoComplete="off" maxLength={512} required disabled={busy} />
          </label>
          <div className="record-actions"><button disabled={busy}>{busy ? "Validando…" : "Validar e salvar"}</button></div>
        </form>
      )}
    </div>
  );
}
