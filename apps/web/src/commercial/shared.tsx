import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { RegistrationError, errorMessage, type useRegistrationRequest } from "../registrations/api";

export type Request = ReturnType<typeof useRegistrationRequest>;
export type Listing<T> = { items: T[]; hasNext: boolean };
const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const calendar = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });
const timestamp = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
export const brl = (amount: string | number) => currency.format(Number(amount));
export const localToday = () => calendar.format(new Date());
export const dateLabel = (iso: string) => iso.slice(0, 10).split("-").reverse().join("/");
export const timeLabel = (iso: string) => timestamp.format(new Date(iso));
export const field = (data: FormData, key: string) => String(data.get(key) ?? "").trim();

const errors: Record<string, string> = {
  "invalid-input": "Confira os campos e os valores informados.",
  "duplicate-registration": "Já existe um cadastro com este código.",
  "invalid-stock": "O estoque disponível não permite esta movimentação.",
  "product-has-stock": "Zere o saldo de estoque antes de arquivar este produto.",
  "supplier-unavailable": "O fornecedor não está disponível nesta empresa.",
  "customer-required": "Selecione um cliente.",
  "customer-unavailable": "O cliente não está disponível nesta empresa.",
  "service-unavailable": "O serviço não está disponível nesta empresa.",
  "item-unavailable": "Um item do catálogo não está mais disponível.",
  "amount-too-large": "O total ultrapassa o limite aceito.",
  "installment-too-small": "O total da venda deve permitir pelo menos um centavo por parcela.",
  "due-date-required": "Edite a venda e informe o vencimento do recebimento.",
  "order-state": "Essa ação não está disponível na situação atual.",
  "order-changed": "O registro mudou. Recarregue os dados antes de tentar novamente.",
  "order-has-invoice": "Há um registro fiscal vinculado. Revise o vínculo antes de cancelar a venda.",
  "order-has-payments": "Estorne as baixas no financeiro antes de cancelar a venda.",
  "order-needs-single-service": "Para gerar um rascunho, a venda precisa ter itens de um único serviço cadastrado.",
  "entry-cannot-cancel": "Para cancelar uma conta vinculada, cancele a venda. Se houver baixas, estorne-as antes.",
  "payment-exceeds-balance": "O valor ultrapassa o saldo em aberto ou a conta está cancelada.",
  "idempotency-conflict": "O envio anterior usou dados diferentes. Recarregue a tela antes de tentar de novo.",
};
export const commercialError = (error: unknown) =>
  (error instanceof RegistrationError && error.code && errors[error.code]) || errorMessage(error);

export function useResource<T>(request: Request, path: string) {
  const [result, setResult] = useState<{ path: string; data?: T; error?: string }>();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    request<T>(path, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setResult({ path, data }); })
      .catch((error) => { if (!controller.signal.aborted) setResult({ path, error: commercialError(error) }); });
    return () => controller.abort();
  }, [request, path, version]);
  return {
    data: result?.path === path ? result.data : undefined,
    error: result?.path === path ? result.error : undefined,
    reload: () => setVersion((value) => value + 1),
  };
}

export function useAction() {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(commercialError(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return { busy, error, run };
}

export function useSubmissionKey() {
  const pending = useRef<{ payload: string; key: string } | undefined>(undefined);
  return (payload: object) => {
    const value = JSON.stringify(payload);
    if (pending.current?.payload !== value) pending.current = { payload: value, key: crypto.randomUUID() };
    return pending.current.key;
  };
}

export function jsonRequest(method: string, body?: object, extra?: Record<string, string>): RequestInit {
  return {
    method,
    headers: { ...(body && { "Content-Type": "application/json" }), ...extra },
    body: body && JSON.stringify(body),
  };
}

export function Pager({ page, hasNext, onChange }: { page: number; hasNext?: boolean; onChange: (page: number) => void }) {
  if (page === 1 && !hasNext) return null;
  return <div className="commercial-actions">
    <button type="button" className="secondary" onClick={() => onChange(page - 1)} disabled={page <= 1}>Anterior</button>
    <span>Página {page}</span>
    <button type="button" className="secondary" onClick={() => onChange(page + 1)} disabled={!hasNext || page >= 10_000}>Próxima</button>
  </div>;
}

export function Notice({ error, pending, reload }: { error?: string; pending?: boolean; reload?: () => void }) {
  if (error) return <p role="alert" className="error">{error} {reload && <button type="button" className="button-link" onClick={reload}>Tentar novamente</button>}</p>;
  return pending ? <p role="status">Carregando…</p> : null;
}

export function Editor({ title, action, onSubmit, onClose, children }: {
  title: string; action: ReturnType<typeof useAction>; onSubmit: (form: FormData) => Promise<void>; onClose: () => void; children: ReactNode;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void action.run(() => onSubmit(form));
  }
  return <section className="panel commercial-panel">
    <h2>{title}</h2>
    <form onSubmit={submit}>
      <fieldset className="commercial-fields" disabled={action.busy}>{children}</fieldset>
      <Notice error={action.error} />
      <div className="commercial-actions">
        <button type="submit" disabled={action.busy}>{action.busy ? "Salvando…" : "Salvar"}</button>
        <button type="button" className="secondary" onClick={onClose} disabled={action.busy}>Voltar</button>
      </div>
    </form>
  </section>;
}

export function MoneyField({ name, label, value = "", required = true }: { name: string; label: string; value?: string; required?: boolean }) {
  return <label>{label}<input name={name} inputMode="decimal" defaultValue={value} maxLength={15} pattern="[0-9]+([.,][0-9]{1,2})?" placeholder="0,00" required={required} /></label>;
}
