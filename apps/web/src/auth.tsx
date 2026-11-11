import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Brand, FiscalIllustration, Icon } from "./ui";
import { DocumentInput } from "./formatted-inputs";
import { formatDocument } from "./format";
import "./auth.css";

export const roleNames = {
  OWNER: "Proprietário",
  ADMIN: "Administrador",
  OPERATOR: "Operador",
  ACCOUNTANT: "Contador",
  VIEWER: "Visualizador",
};

export type Role = keyof typeof roleNames;

type Session = {
  user: { name: string };
  organization: { id: string; legalName: string };
  role: Role;
  platformOwner: boolean;
};

type LoginAccount = { key: string; legalName: string; cnpj: string | null };

export type SignedIn = {
  account: ReactNode;
  role: Role;
  platformOwner: boolean;
  organizationId: string;
  endSession: () => void;
  renameOrganization: (name: string) => void;
};

function authRequest(path: string, options?: RequestInit) {
  return fetch(`/api/auth/${path}`, { credentials: "same-origin", ...options, cache: "no-store" });
}

async function currentSession(signal?: AbortSignal): Promise<Session | null> {
  const response = await authRequest("session", { signal });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Session unavailable");
  return response.json();
}

function AuthCard({ children }: { children: ReactNode }) {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="auth-intro">
          <Brand />
          <div className="auth-intro-copy">
            <p className="auth-intro-title">Sua empresa, sua rotina fiscal.</p>
            <p>Organize clientes, serviços e documentos de NFS-e em um só lugar.</p>
            <FiscalIllustration />
          </div>
        </div>
        <div className="auth-content">
          <div className="auth-brand"><Brand /></div>
          {children}
        </div>
      </div>
    </main>
  );
}

function ActivateAccount({ code, onClose }: { code: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [activated, setActivated] = useState<{ cnpj: string | null; documentType: "CPF" | "CNPJ" }>();
  const [error, setError] = useState("");

  async function activate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const password = values.get("password");
    if (password !== values.get("confirmation")) {
      setError("As duas senhas precisam ser iguais.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await authRequest("activate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, password }),
      });
      if (response.ok) {
        const data = await response.json();
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
        setActivated(data);
      } else if (response.status === 404) {
        setError("Este convite venceu ou não está mais disponível. Solicite um novo link.");
      } else if (response.status === 403) {
        setError("Este e-mail já tem cadastro. Informe sua senha atual do Fiscal Floow.");
      } else if (response.status === 429) {
        setError("Muitas tentativas. Aguarde alguns minutos.");
      } else {
        setError("Não foi possível ativar o acesso. Tente novamente.");
      }
    } catch {
      setError("O serviço está indisponível. Tente novamente.");
    } finally {
      form.reset();
      setBusy(false);
    }
  }

  return <AuthCard>
    <h1>{activated ? "Acesso ativado" : "Ative seu acesso"}</h1>
    {activated ? <>
      <p role="status">Entre com {activated.cnpj ? "o CNPJ " + formatDocument(activated.cnpj) : "o CPF cadastrado"}, o e-mail do convite e sua senha.</p>
      <button type="button" onClick={onClose}>Ir para o Fiscal Floow</button>
    </> : <>
      <p>Crie uma senha de pelo menos 15 caracteres. Se já usa o Fiscal Floow, informe sua senha atual.</p>
      <form className="auth-form" onSubmit={activate}>
        <label>Senha<input type="password" name="password" minLength={15} maxLength={128} autoComplete="new-password" required /></label>
        <label>Repita a senha<input type="password" name="confirmation" minLength={15} maxLength={128} autoComplete="new-password" required /></label>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button disabled={busy}>{busy ? "Ativando…" : "Ativar acesso"}</button>
        <button type="button" className="button-secondary" disabled={busy} onClick={onClose}>Voltar</button>
      </form>
    </>}
  </AuthCard>;
}

export function AuthGate({ children }: { children: (context: SignedIn) => ReactNode }) {
  const [activationCode, setActivationCode] = useState(() => /^#ativar=([A-Za-z0-9_-]{43})$/.exec(window.location.hash)?.[1]);
  const [session, setSession] = useState<Session | null>();
  const [accounts, setAccounts] = useState<LoginAccount[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const endSession = useCallback(() => { setError(""); setSession(null); }, []);
  const renameOrganization = useCallback((legalName: string) => {
    setSession((current) => current && { ...current, organization: { ...current.organization, legalName } });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    currentSession(controller.signal).then(setSession).catch(() => {
      if (!controller.signal.aborted) setError("Não foi possível consultar a sessão.");
    });
    return () => controller.abort();
  }, [retry]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    let keepPassword = false;
    setBusy(true);
    setError("");
    try {
      const response = await authRequest("login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      if (response.status === 401) {
        setAccounts([]);
        setError("Confira o CPF ou CNPJ, o e-mail e a senha.");
      } else if (response.status === 400) {
        setError("Confira o formato do CPF ou CNPJ e do e-mail.");
      } else if (response.status === 429) {
        setError("Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.");
      } else if (response.status === 409) {
        const result = await response.json() as { code: string; accounts: LoginAccount[] };
        if (result.code === "choose-account") {
          setAccounts(result.accounts);
          keepPassword = true;
        }
      } else if (response.ok) {
        const signedIn = await currentSession();
        if (signedIn) {
          setAccounts([]);
          setSession(signedIn);
        }
        else setError("A sessão não foi mantida. Verifique se os cookies estão habilitados.");
      } else {
        setError("Não foi possível entrar. Tente novamente.");
      }
    } catch {
      setError("A API está indisponível. Tente novamente.");
    } finally {
      const password = form.elements.namedItem("password");
      if (!keepPassword && password instanceof HTMLInputElement) password.value = "";
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    setError("");
    try {
      const response = await authRequest("logout", { method: "POST" });
      if (!response.ok) throw new Error("Logout failed");
      setSession(null);
    } catch {
      setError("Não foi possível encerrar a sessão. Tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  if (activationCode) return <ActivateAccount code={activationCode} onClose={() => {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    setActivationCode(undefined);
  }} />;

  if (session === undefined) {
    return (
      <AuthCard>
        <p role={error ? "alert" : "status"}>{error || "Verificando sessão…"}</p>
        {error && <button onClick={() => { setError(""); setRetry((attempt) => attempt + 1); }}>Tentar novamente</button>}
      </AuthCard>
    );
  }

  if (!session) {
    const choosing = accounts.length > 0;
    return (
      <AuthCard>
        <h1>Entre no Fiscal Floow</h1>
        <p>{choosing ? "Escolha a conta que deseja abrir." : "Informe o CPF ou CNPJ cadastrado, seu e-mail e sua senha."}</p>
        <form className="auth-form" onSubmit={login}>
          <label>CPF ou CNPJ<DocumentInput name="organizationDocument" autoComplete="off" readOnly={busy || choosing} required /></label>
          <label>E-mail<input type="email" name="email" maxLength={254} autoComplete="username" readOnly={busy || choosing} required /></label>
          <label>Senha<input type="password" name="password" maxLength={128} autoComplete="current-password" required /></label>
          {choosing && <label>Conta
            <select name="account" defaultValue="" required autoFocus>
              <option value="" disabled>Selecione uma conta</option>
              {accounts.map((account) => <option key={account.key} value={account.key}>
                {account.legalName} · {account.cnpj ? "CNPJ " + formatDocument(account.cnpj) : "Pessoa física"}
              </option>)}
            </select>
          </label>}
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button>
          {choosing && <button type="reset" className="button-secondary" disabled={busy} onClick={() => {
            setAccounts([]);
            setError("");
          }}>Voltar</button>}
        </form>
      </AuthCard>
    );
  }

  const accountRoleName = session.role === "OWNER" && !session.platformOwner ? "Assinante" : roleNames[session.role];

  return children({
    role: session.role,
    platformOwner: session.platformOwner,
    organizationId: session.organization.id,
    endSession,
    renameOrganization,
    account: (
      <div className="auth-account">
        <span className="account-icon"><Icon name="building" /></span>
        <div className="account-details">
          <strong>{session.organization.legalName}</strong>
          <small>{session.user.name} · {accountRoleName}</small>
          {error && <p className="auth-error" role="alert">{error}</p>}
        </div>
        <button className="account-logout" onClick={logout} disabled={busy}><Icon name="logout" />{busy ? "Saindo…" : "Sair"}</button>
      </div>
    ),
  });
}
