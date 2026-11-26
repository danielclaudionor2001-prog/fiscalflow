import { useEffect, useState } from "react";
import { formatDocument } from "../format";
import type { useRegistrationRequest } from "../registrations/api";
import { CustomerOrderSelect, type CustomerOrder } from "../registrations/customer-order";

type Request = ReturnType<typeof useRegistrationRequest>;
type Page<T> = { items: T[]; hasNext: boolean };

export type CatalogOption = { id: string; name: string; federalTaxId?: string; active?: boolean; description?: string; defaultAmount?: string; price?: string; sku?: string };

export function CatalogPicker({ request, resource, label, value, initial, onChange, required = resource === "customers" }: {
  request: Request;
  resource: "customers" | "services" | "commercial/products" | "commercial/suppliers";
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
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<CatalogOption>();
  const [sort, setSort] = useState<CustomerOrder>("name_asc");

  useEffect(() => {
    if (search.trim() === query) return;
    const timer = window.setTimeout(() => {
      setPage(1);
      setQuery(search.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, query]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    if (page === 1) setListing(undefined);
    const params = new URLSearchParams({ page: String(page) });
    if (resource === "customers" && query) params.set("q", query);
    if (resource === "customers") params.set("sort", sort);
    request<Page<CatalogOption>>(`${resource}?${params}`, { signal: controller.signal })
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
  }, [request, resource, page, attempt, query, sort]);

  const available = listing?.items.filter((item) => item.active !== false) ?? [];
  const retained = initial?.id === value ? initial : selected?.id === value ? selected : undefined;
  const items = retained && !available.some((item) => item.id === retained.id) ? [retained, ...available] : available;
  return (
    <div className="catalog-picker">
      {resource === "customers" && <div className="customer-picker-tools"><label>Pesquisar cliente pelo nome
        <input type="search" value={search} maxLength={120} onChange={(event) => setSearch(event.target.value)} />
      </label><CustomerOrderSelect value={sort} onChange={(value) => { setPage(1); setSort(value); }} /></div>}
      <label>{label}
        <select value={value} required={required} onChange={(event) => {
          const option = items.find((item) => item.id === event.target.value);
          setSelected(option);
          onChange(option);
        }}>
          <option value="">{required ? "Selecione uma opção" : resource === "services" ? "Sem serviço vinculado" : "Nenhum"}</option>
          {items.map((item) => <option key={item.id} value={item.id}>{item.federalTaxId ? `${item.name} (${formatDocument(item.federalTaxId)})` : item.name}</option>)}
        </select>
      </label>
      {loading && <small role="status">Carregando…</small>}
      {error && <button type="button" className="button-link" onClick={() => setAttempt((current) => current + 1)}>Tentar carregar novamente</button>}
      {!loading && !error && listing?.hasNext && page < 10000 && (
        <button type="button" className="button-link" onClick={() => setPage(page + 1)}>Carregar mais</button>
      )}
      {!loading && !error && required && !available.length && <small>{query ? "Nenhum cliente encontrado." : "Nenhum cadastro disponível nesta página."}</small>}
    </div>
  );
}
