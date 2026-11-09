import { useEffect, useState } from "react";
import type { useRegistrationRequest } from "../registrations/api";

type Request = ReturnType<typeof useRegistrationRequest>;
type Page<T> = { items: T[]; hasNext: boolean };
export type CatalogOption = { id: string; name: string; federalTaxId?: string; active?: boolean; description?: string; defaultAmount?: string };

export function CatalogPicker({ request, resource, label, value, initial, onChange, required = resource === "customers" }: {
  request: Request;
  resource: "customers" | "services";
  label: string;
  value: string;
  initial?: CatalogOption;
  required?: boolean;
  onChange: (option: CatalogOption | undefined) => void;
}) {
  const [page, setPage] = useState(1);
  const [listing, setListing] = useState<Page<CatalogOption>>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    request<Page<CatalogOption>>(`${resource}?page=${page}`, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setListing((current) => {
          const items = new Map((page === 1 ? [] : current?.items ?? []).map((item) => [item.id, item]));
          for (const item of data.items) items.set(item.id, item);
          return { items: [...items.values()], hasNext: data.hasNext };
        });
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [request, resource, page, attempt]);

  const available = listing?.items.filter((item) => item.active !== false) ?? [];
  const items = initial && !available.some((item) => item.id === initial.id) ? [initial, ...available] : available;
  return (
    <div>
      <label>{label}
        <select value={value} required={required} onChange={(event) => onChange(items.find((item) => item.id === event.target.value))}>
          <option value="">{required ? "Selecione uma opção" : "Sem serviço vinculado"}</option>
          {items.map((item) => <option key={item.id} value={item.id}>{item.federalTaxId ? `${item.name} (${item.federalTaxId})` : item.name}</option>)}
        </select>
      </label>
      {loading && <small role="status">Carregando…</small>}
      {error && <button type="button" className="button-link" onClick={() => setAttempt((current) => current + 1)}>Tentar carregar novamente</button>}
      {!loading && !error && listing?.hasNext && page < 10000 && (
        <button type="button" className="button-link" onClick={() => setPage(page + 1)}>Carregar mais</button>
      )}
      {!loading && !error && required && !items.length && <small>Nenhum cadastro disponível nesta página.</small>}
    </div>
  );
}
