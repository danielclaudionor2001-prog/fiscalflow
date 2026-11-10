import { useEffect, useState, type FormEvent } from "react";
import { errorMessage, jsonMutation, RegistrationError, useRegistrationRequest, type PageAccess } from "./api";

import { DocumentInput } from "../formatted-inputs";

type CpfLogin = { cpfMasked: string | null };

export function CpfLoginCard({ organizationId, endSession }: Pick<PageAccess, "organizationId" | "endSession">) {
  const request = useRegistrationRequest(organizationId, endSession);
  const [link, setLink] = useState<CpfLogin>();
  const [mode, setMode] = useState<"save" | "remove">();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    request<CpfLogin>("auth/cpf-login", { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setLink(result); })
      .catch((failure) => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [request, retry]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !mode) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await request<CpfLogin>("auth/cpf-login", jsonMutation("PUT", {
        cpf: mode === "remove" ? null : String(fields.get("cpf") ?? ""),
        password: String(fields.get("password") ?? ""),
      }));
      setLink(saved);
      setMode(undefined);
      setNotice(saved.cpfMasked ? "CPF vinculado ao seu acesso nesta empresa." : "CPF desvinculado.");
    } catch (failure) {
      setError(failure instanceof RegistrationError && failure.code === "password-confirmation-failed"
        ? "Confira sua senha atual do Fiscal Floow."
        : errorMessage(failure));
    } finally {
      const password = form.elements.namedItem("password");
      if (password instanceof HTMLInputElement) password.value = "";
      setBusy(false);
    }
  }

  function edit(next: typeof mode) {
    setMode(next);
    setError("");
    setNotice("");
  }

  return <section className="registry-card" aria-labelledby="cpf-login-title">
    <h2 id="cpf-login-title">Acesso com CPF</h2>
    <p>Vincule seu CPF para entrar nesta empresa com o mesmo e-mail e senha.</p>
    {error && <p role="alert" className="registry-error">{error}</p>}
    {notice && <p role="status" className="registry-notice">{notice}</p>}
    {!link && (error
      ? <button type="button" className="button-secondary" onClick={() => { setError(""); setRetry((value) => value + 1); }}>Tentar novamente</button>
      : <p role="status">Carregando seu acesso…</p>)}
    {link?.cpfMasked && <p>CPF vinculado: <strong>{link.cpfMasked}</strong></p>}
    {link && !mode && <div className="record-actions">
      <button type="button" className="button-secondary" onClick={() => edit("save")}>{link.cpfMasked ? "Alterar CPF" : "Vincular CPF"}</button>
      {link.cpfMasked && <button type="button" className="button-secondary" onClick={() => edit("remove")}>Desvincular CPF</button>}
    </div>}
    {mode && <form className="record-form" onSubmit={save}>
      <fieldset disabled={busy}>
        {mode === "save" && <label>Seu CPF<DocumentInput mode="cpf" name="cpf" autoComplete="off" required /></label>}
        <label>Senha atual<input name="password" type="password" autoComplete="current-password" maxLength={128} required /></label>
      </fieldset>
      <div className="record-actions">
        <button disabled={busy}>{busy ? "Salvando…" : mode === "remove" ? "Confirmar desvinculação" : "Salvar CPF"}</button>
        <button type="button" className="button-secondary" disabled={busy} onClick={() => edit(undefined)}>Cancelar</button>
      </div>
    </form>}
  </section>;
}
