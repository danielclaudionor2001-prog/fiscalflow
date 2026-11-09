import { useEffect, useState } from "react";
import { errorMessage, type useRegistrationRequest } from "../registrations/api";

const labels = { CREATED: "Criou", UPDATED: "Editou", ARCHIVED: "Excluiu" };
type Activity = {
  id: string;
  draftId: string;
  action: keyof typeof labels;
  createdAt: string;
  actorName: string | null;
  customerName: string | null;
};
type Listing = { items: Activity[]; hasNext: boolean };

export function InvoiceActivity({ request }: { request: ReturnType<typeof useRegistrationRequest> }) {
  const [listing, setListing] = useState<Listing>();
  const [action, setAction] = useState("");
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ page: String(page) });
    if (action) query.set("action", action);
    setListing(undefined);
    setError("");
    request<Listing>(`invoices/activity?${query}`, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setListing(data); })
      .catch((failure) => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [request, action, page, attempt]);

  return (
    <div className="registry-card" id="invoice-activity">
      <div className="registry-heading">
        <h2>Histórico dos rascunhos</h2>
        <div className="record-form">
          <label>Ação
            <select value={action} onChange={(event) => { setAction(event.target.value); setPage(1); }}>
              <option value="">Todas</option>
              <option value="CREATED">Criação</option>
              <option value="UPDATED">Edição</option>
              <option value="ARCHIVED">Exclusão</option>
            </select>
          </label>
        </div>
      </div>
      {error && <><p role="alert" className="registry-error">{error}</p><button className="button-secondary" onClick={() => setAttempt((current) => current + 1)}>Tentar novamente</button></>}
      {!listing && !error && <p role="status">Carregando histórico…</p>}
      {listing && (listing.items.length ? (
        <div className="registry-table">
          <table aria-label="Histórico dos rascunhos">
            <thead><tr><th scope="col">Data</th><th scope="col">Pessoa</th><th scope="col">Ação</th><th scope="col">Cliente</th></tr></thead>
            <tbody>{listing.items.map((event) => (
              <tr key={event.id}>
                <td>{new Date(event.createdAt).toLocaleString("pt-BR")}</td>
                <td>{event.actorName ?? "Usuário desvinculado"}</td>
                <td>{labels[event.action]}</td>
                <td>{event.customerName ?? "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <p>Nenhum evento nesta página.</p>)}
      {listing && (page > 1 || listing.hasNext) && (
        <div className="record-actions registry-pagination">
          <button className="button-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
          <span>Página {page}</span>
          <button className="button-secondary" disabled={!listing.hasNext || page >= 10000} onClick={() => setPage(page + 1)}>Próxima</button>
        </div>
      )}
    </div>
  );
}
