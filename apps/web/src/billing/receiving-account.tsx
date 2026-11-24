import { useEffect, useState, type FormEvent } from "react";
import { errorMessage, jsonMutation, useRegistrationRequest, type PageAccess } from "../registrations/api";
import { BankPicker } from "./bank-picker";
import { Icon } from "../ui";
import { AsaasConnectionCard } from "./asaas-connection";

type Provider = "CELCOIN" | "OWN_BANK" | "ASAAS";
type ProviderChoice = Exclude<Provider, "CELCOIN">;
type Account = {
  provider: Provider;
  bankName: string;
  bankCode: string | null;
  branch: string | null;
  accountLastFour: string;
};

export function ReceivingAccountPage({ organizationId, endSession, subscription }: PageAccess & { subscription: boolean }) {
  const request = useRegistrationRequest(organizationId, endSession);
  const path = subscription ? "platform/receiving-account" : "receiving-account";
  const [account, setAccount] = useState<Account | null>();
  const [provider, setProvider] = useState<ProviderChoice>("ASAAS");
  const [bank, setBank] = useState<{ code: string; name: string }>();
  const [bankError, setBankError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    request<{ account: Account | null }>(path, { signal: abort.signal })
      .then(({ account: saved }) => {
        if (!abort.signal.aborted) {
          setAccount(saved);
          setProvider(saved?.provider === "OWN_BANK" ? "OWN_BANK" : "ASAAS");
          setBank(saved?.bankCode ? { code: saved.bankCode, name: saved.bankName } : undefined);
          setEditing(!saved || saved.provider === "CELCOIN");
        }
      })
      .catch((failure) => { if (!abort.signal.aborted) setError(errorMessage(failure)); });
    return () => abort.abort();
  }, [path, request, revision]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || provider === "ASAAS") return;
    const data = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    if (provider === "OWN_BANK" && (!data.bankCode || !data.bankName)) {
      setBankError(true);
      setError("Escolha a instituição ou informe os dados do banco.");
      return;
    }
    setBankError(false);
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const result = await request<{ account: Account }>(path, jsonMutation("PUT", { ...data, provider }));
      setAccount(result.account);
      setEditing(false);
      setNotice("Conta de recebimento cadastrada.");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return <div className="registry">
    <section className="registry-card">
      <div className="registry-heading">
        <h2>{subscription ? "Recebimento das assinaturas" : "Conta de recebimento da empresa"}</h2>
        <a href={subscription ? "#plataforma" : "#boletos"}>{subscription ? "Voltar às empresas" : "Ver boletos"}</a>
      </div>
      <p>Escolha como acompanhar os recebimentos da empresa. Em Meu banco, registre os títulos externos. No Asaas Sandbox, conecte sua conta e gere boletos de teste pelo Fiscal Floow.</p>
      {notice && <p className="registry-notice" role="status">{notice}</p>}
      {error && <p className="registry-error" role="alert">{error}</p>}
      {account === undefined && (error
        ? <button className="button-secondary" onClick={() => { setError(""); setRevision((value) => value + 1); }}>Tentar novamente</button>
        : <p role="status">Carregando conta…</p>)}
      {account && <div className="receiving-account-summary">
        <span className="bank-icon"><Icon name="building" /></span>
        <div><strong>{account.bankName}</strong>
          <div>{[account.branch && "Agência " + account.branch, account.accountLastFour && "Conta final " + account.accountLastFour].filter(Boolean).join(" · ")}</div>
        </div>
      </div>}
      {account && !editing && <div className="record-actions"><button onClick={() => {
        setProvider(account.provider === "OWN_BANK" ? "OWN_BANK" : "ASAAS");
        setBank(account.bankCode ? { code: account.bankCode, name: account.bankName } : undefined);
        setBankError(false);
        setError("");
        setNotice("");
        setEditing(true);
      }}>Alterar conta</button>
        {provider !== "ASAAS" && <button className="button-secondary" onClick={() => {
          setProvider("ASAAS"); setError(""); setNotice("");
        }}>Conectar Asaas Sandbox</button>}
      </div>}
      {account?.provider === "CELCOIN" && <p className="record-hint">Conecte o Asaas abaixo para utilizá-lo nas próximas cobranças de teste. Os dados anteriores continuam preservados no histórico.</p>}
    </section>
    {editing && <form className="registry-card record-form receiving-form" onSubmit={save}>
      <h2>{account ? "Alterar conta" : "Cadastrar conta"}</h2>
      <fieldset disabled={busy}>
        <div className="receiving-wide">
          <h3 id="receiving-provider-title">Onde sua empresa recebe</h3>
          <div className="receiving-providers" role="radiogroup" aria-labelledby="receiving-provider-title">
            {(["ASAAS", "OWN_BANK"] as const).map((choice) => <label key={choice} className="receiving-provider">
              <input type="radio" name="provider" value={choice} checked={provider === choice} onChange={() => {
                setProvider(choice);
                setBankError(false);
                setError("");
              }} />
              <span className="bank-icon"><Icon name="building" /></span>
              <span><strong>{choice === "ASAAS" ? "Asaas" : "Meu banco"}</strong>
                <small>{choice === "ASAAS" ? "Conecte sua conta Sandbox para boletos de teste" : "Bancos, cooperativas e contas digitais"}</small>
              </span>
            </label>)}
          </div>
        </div>
        {provider === "OWN_BANK" && <>
          <div className="receiving-bank receiving-wide"><BankPicker selected={bank} onChange={(selection) => {
            setBank(selection);
            setBankError(false);
            setError("");
          }} requiredError={bankError} /></div>
          <label>Agência<input name="branch" required maxLength={10} defaultValue={account?.branch ?? ""} /></label>
        </>}
        {provider !== "ASAAS" && <label>Conta com dígito<input name="accountNumber" autoComplete="off" required maxLength={21} placeholder="Ex. 12345-6" /></label>}
        {provider === "ASAAS" && <p className="receiving-wide">Use o formulário de conexão abaixo. A conta será selecionada após a validação da chave de testes.</p>}
      </fieldset>
      <div className="record-actions">
        {provider !== "ASAAS" && <button disabled={busy}>{busy ? "Salvando…" : "Salvar conta"}</button>}
        {account && <button type="button" className="button-secondary" disabled={busy} onClick={() => setEditing(false)}>Cancelar</button>}
      </div>
    </form>}
    {provider === "ASAAS" && <AsaasConnectionCard request={request} path={path} connected={() => setRevision((n) => n + 1)} />}
  </div>;
}
