import { useEffect, useState, type FormEvent } from "react";
import { errorMessage, RegistrationError, useRegistrationRequest, type PageAccess } from "../registrations/api";

type Status = {
  enabled: boolean;
  certificate: { version: string; validFrom: string; validUntil: string; savedAt: string; expired: boolean } | null;
};

const formatDate = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short",
});
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

  useEffect(() => {
    const controller = new AbortController();
    request<Status>("certificates", { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setStatus(result); })
      .catch((failure) => { if (!controller.signal.aborted) setError(message(failure)); });
    return () => controller.abort();
  }, [request, reload]);

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
      setConfirm(false);
      setNotice("Certificado removido do FiscalFlow.");
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="registry">
      {error && <p className="registry-error" role="alert">{error}</p>}
      {notice && <p className="registry-notice" role="status">{notice}</p>}
      <div className="registry-card">
        <h2>Certificado e-CNPJ A1</h2>
        {!status && !error && <p role="status">Carregando certificado…</p>}
        {error && <button type="button" className="button-secondary" disabled={busy} onClick={() => {
          setError(""); setConfirm(false); setReload((current) => current + 1);
        }}>Recarregar situação</button>}
        {status && (certificate ? (
          <dl className="record-details">
            <div><dt>Situação</dt><dd>{certificate.expired ? "Vencido" : "Cadastrado e dentro da validade"}</dd></div>
            <div><dt>Válido até</dt><dd>{formatDate.format(new Date(certificate.validUntil))}</dd></div>
          </dl>
        ) : <p>Esta empresa ainda não tem certificado cadastrado.</p>)}
        {status && !status.enabled && <p>O cadastro de certificados está indisponível até a configuração do cofre na API.</p>}
        {certificate && role === "OWNER" && (
          confirm ? <div className="archive-confirmation">
            <p>Remover o certificado cadastrado nesta empresa?</p>
            <div className="record-actions">
              <button type="button" className="button-danger" disabled={busy} onClick={() => void remove()}>Confirmar remoção</button>
              <button type="button" className="button-secondary" disabled={busy} onClick={() => setConfirm(false)}>Cancelar</button>
            </div>
          </div> : <button type="button" className="button-secondary" disabled={busy} onClick={() => setConfirm(true)}>Remover certificado</button>
        )}
      </div>
      {status?.enabled && role === "OWNER" && !confirm && (
        <form className="record-form registry-card" onSubmit={upload}>
          <h2>{certificate ? "Substituir certificado" : "Cadastrar certificado"}</h2>
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
