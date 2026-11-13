import { useState, type FormEvent } from "react";
import { DocumentInput } from "../formatted-inputs";
import { Brand } from "../ui";
import type { CommercialBrand } from "./branding";
import { OrderDocument, type CommercialDocumentData } from "./order-document";
import { dateLabel, field, jsonRequest, localToday, Notice, timeLabel, useAction, type Request } from "./shared";

type Decision = "APPROVED" | "DECLINED";
export type QuoteShare = {
  expiresAt: string; revokedAt: string | null; decision: Decision | null; respondedAt: string | null;
};
const decisionLabel: Record<Decision, string> = { APPROVED: "Aprovado pelo cliente", DECLINED: "Recusado pelo cliente" };

export function quoteDecisionLabel(share: Pick<QuoteShare, "decision"> | null) {
  return share?.decision ? decisionLabel[share.decision] : undefined;
}

export function QuoteShareCard({ request, id, updatedAt, status, dueOn, share, write, reload }: {
  request: Request; id: string; updatedAt: string; status: "OPEN" | "CONFIRMED" | "CANCELLED";
  dueOn: string | null; share: QuoteShare | null; write: boolean; reload: () => void;
}) {
  const [generated, setGenerated] = useState<{ url: string; expiresAt: string }>();
  const [copyStatus, setCopyStatus] = useState("");
  const action = useAction();
  const route = "commercial/orders/" + encodeURIComponent(id) + "/share";
  const headers = { "If-Match": '"' + updatedAt + '"' };
  const withinDueDate = !dueOn || dueOn.slice(0, 10) >= localToday();
  const active = share && !share.revokedAt && Date.parse(share.expiresAt) > Date.now() &&
    status !== "CANCELLED" && (share.decision || (status === "OPEN" && withinDueDate));
  const url = active && generated && generated.expiresAt === share.expiresAt ? generated.url : undefined;
  const canGenerate = write && status === "OPEN" && !share?.decision && withinDueDate;
  if (!write && !share?.decision) return null;

  function generate() {
    if (active && !window.confirm("Gerar outro link e desativar o anterior?")) return;
    void action.run(async () => {
      setCopyStatus("");
      const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      const tokenHash = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const saved = await request<QuoteShare>(route, jsonRequest("PUT", { tokenHash }, headers));
      const url = new URL(window.location.pathname, window.location.origin);
      url.hash = "orcamento-express=" + token;
      setGenerated({ url: url.href, expiresAt: saved.expiresAt });
      reload();
    });
  }

  function revoke() {
    if (!window.confirm("Desativar este link de orçamento?")) return;
    void action.run(async () => {
      await request(route, jsonRequest("DELETE", undefined, headers));
      setGenerated(undefined);
      setCopyStatus("Link desativado.");
      reload();
    });
  }

  return <section className="panel commercial-panel quote-share">
    <h2>Orçamento Express</h2>
    <p>Envie o link ao cliente. Ele usa o CPF ou CNPJ cadastrado no orçamento para abrir e responder.</p>
    {canGenerate && <p>Os itens, os valores e as observações ficam visíveis ao cliente após a conferência do documento.</p>}
    {share?.decision ? <p role="status"><strong>{decisionLabel[share.decision]}</strong>
      {share.respondedAt && " · " + timeLabel(share.respondedAt)}</p>
      : active ? <p role="status">Aguardando resposta do cliente.</p>
        : share && <p role="status">{share.revokedAt ? "Link desativado." : "Link indisponível."}</p>}
    {canGenerate && active && <p>Disponível por até 30 dias, respeitando a validade do orçamento.</p>}
    {!withinDueDate && status === "OPEN" && !share?.decision && <p>Atualize a validade do orçamento para gerar um link.</p>}
    {url && <label className="quote-share-link">Link para o cliente
      <input readOnly value={url} onFocus={(event) => event.currentTarget.select()} />
    </label>}
    <Notice error={action.error} reload={reload} />
    {copyStatus && <p role="status">{copyStatus}</p>}
    <div className="commercial-actions">
      {canGenerate && <button type="button" disabled={action.busy} onClick={generate}>{active ? "Gerar novo link" : "Gerar link para o cliente"}</button>}
      {url && <button type="button" className="secondary" onClick={async () => {
        try { await navigator.clipboard.writeText(url); setCopyStatus("Link copiado."); }
        catch { setCopyStatus("Selecione o endereço do campo e copie o link."); }
      }}>Copiar link</button>}
      {write && active && <button type="button" className="secondary" disabled={action.busy} onClick={revoke}>Desativar link</button>}
      {active && !share.decision && <button type="button" className="secondary" onClick={reload}>Consultar resposta</button>}
    </div>
  </section>;
}

type PublicQuote = CommercialDocumentData & Pick<QuoteShare, "decision" | "respondedAt"> & { brand: CommercialBrand };

export function PublicQuotePage({ token }: { token: string }) {
  const [quote, setQuote] = useState<PublicQuote>();
  const [document, setDocument] = useState("");
  const [confirming, setConfirming] = useState<Decision>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const validLink = /^[A-Za-z0-9_-]{43}$/.test(token);

  async function access(customerDocument: string, decision?: Decision) {
    if (!validLink || busy) return;
    setBusy(true);
    setError("");
    try {
      const route = decision ? "respond" : "view";
      const response = await fetch("/api/quote-express/" + route, {
        ...jsonRequest("POST", { token, document: customerDocument, ...(decision && { decision }) }),
        cache: "no-store", credentials: "omit",
      });
      if (response.ok) {
        setQuote(await response.json() as PublicQuote);
        setDocument(customerDocument);
        setConfirming(undefined);
      } else if (response.status === 429) {
        setError("Muitas tentativas. Aguarde alguns minutos e tente novamente.");
      } else if (response.status === 409) {
        setConfirming(undefined);
        setError("Já existe uma resposta. Clique em Atualizar orçamento para consultá-la.");
      } else if (response.status === 400 || response.status === 404) {
        if (decision) setQuote(undefined);
        setConfirming(undefined);
        setError("Confira o CPF ou CNPJ do cliente e se o link ainda está válido. Se precisar, peça um novo link à empresa.");
      } else {
        setError("Não foi possível consultar o orçamento. Tente novamente em instantes.");
      }
    } catch {
      setError("Não foi possível conectar. Verifique sua internet e tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  function open(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void access(field(new FormData(event.currentTarget), "document"));
  }

  return <main className="quote-public commercial-stack">
    <header className="quote-public-header">
      <Brand />
      <h1>Orçamento Express</h1>
    </header>
    {!validLink ? <section className="panel commercial-panel"><p role="alert">Link incompleto. Peça um novo link à empresa.</p></section>
      : !quote ? <section className="panel commercial-panel quote-unlock">
        <h2>Abrir orçamento</h2>
        <p>Informe o CPF ou CNPJ em que você recebeu a proposta.</p>
        <form className="record-form" onSubmit={open}>
          <label>CPF ou CNPJ do cliente<DocumentInput name="document" required autoComplete="off" /></label>
          <Notice error={error} />
          <button disabled={busy}>{busy ? "Abrindo…" : "Ver orçamento"}</button>
        </form>
      </section> : <>
        <OrderDocument order={quote} title="Orçamento" status={quoteDecisionLabel(quote)} brand={quote.brand} quote />
        <section className="panel commercial-panel quote-response">
          <Notice error={error} />
          {quote.decision ? <p role="status"><strong>{decisionLabel[quote.decision]}.</strong>
            {quote.respondedAt && " Resposta registrada em " + timeLabel(quote.respondedAt) + "."}</p>
            : confirming ? <>
              <p>Confirma que deseja {confirming === "APPROVED" ? "aprovar" : "recusar"} este orçamento?</p>
              <div className="commercial-actions">
                <button disabled={busy} onClick={() => void access(document, confirming)}>{confirming === "APPROVED" ? "Confirmar aprovação" : "Confirmar recusa"}</button>
                <button className="secondary" disabled={busy} onClick={() => setConfirming(undefined)}>Voltar</button>
              </div>
            </> : <div className="commercial-actions">
              <button disabled={busy} onClick={() => setConfirming("APPROVED")}>Aprovar orçamento</button>
              <button className="secondary" disabled={busy} onClick={() => setConfirming("DECLINED")}>Recusar orçamento</button>
            </div>}
          {error && !confirming && <div className="commercial-actions">
            <button className="secondary" disabled={busy} onClick={() => void access(document)}>Atualizar orçamento</button>
          </div>}
        </section>
      </>}
  </main>;
}
