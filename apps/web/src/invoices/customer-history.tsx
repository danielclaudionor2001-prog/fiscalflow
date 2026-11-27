import { dateLabel } from "../format";
import { useEffect, useRef, useState } from "react";
import { errorMessage, RegistrationError, useRegistrationResponse, type PageAccess } from "../registrations/api";
import { CollectionHeading, EmptyCollection, EntityTitle, PageCount, StatusPill } from "../collection-ui";
import { Icon } from "../ui";

const statusLabels = {
  DRAFT: "Rascunho",
  QUEUED: "Na fila",
  PROCESSING: "Em processamento",
  AUTHORIZED: "NFS-e autorizada",
  REJECTED: "Rejeitada",
  CANCEL_REQUESTED: "Cancelamento solicitado",
  CANCELLED: "Cancelada",
  FAILED: "Falha",
};

type History = {
  customer?: { name: string };
  items: Array<{
    id: string;
    customerId?: string;
    customerName?: string;
    status: keyof typeof statusLabels;
    serviceDescription: string;
    amount: string;
    date: string;
    dpsId?: string | null;
    accessKey: string | null;
    hasXml?: boolean;
  }>;
  hasNext: boolean;
};

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

const customerInvoicesPath = (id: string) => "customers/" + encodeURIComponent(id) + "/invoices";

export function InvoiceHistoryPage({ customerId, organizationId, role, endSession }: PageAccess & { customerId?: string }) {
  const canViewBilling = role === "OWNER" || role === "ADMIN" || role === "ACCOUNTANT";
  const request = useRegistrationResponse(organizationId, endSession);
  const path = customerId ? customerInvoicesPath(customerId) : "invoices/issued";
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [history, setHistory] = useState<History>();
  const title = customerId ? (history?.customer ? "Notas de " + history.customer.name : "Notas do cliente") : "Notas emitidas";
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState<string>();
  const [downloadError, setDownloadError] = useState("");
  const download = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setHistory(undefined);
    setError("");
    request(path + "?page=" + page, { signal: controller.signal })
      .then((response) => response.json() as Promise<History>)
      .then((data) => { if (!controller.signal.aborted) setHistory(data); })
      .catch((failure) => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [path, page, request, retry]);

  useEffect(() => () => download.current?.abort(), []);

  async function downloadDocument(key: string, documentPath: string, filename: string) {
    if (download.current) return;
    const controller = new AbortController();
    download.current = controller;
    setDownloading(key);
    setDownloadError("");
    try {
      const response = await request(documentPath, { signal: controller.signal });
      const file = await response.blob();
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      if (!controller.signal.aborted) {
        const code = failure instanceof RegistrationError ? failure.code : undefined;
        const messages: Record<string, string> = {
          "dps-pdf-unavailable": "Essa DPS não está mais disponível para baixar.",
          "nfse-xml-unavailable": "O XML desta nota não está disponível.",
          "danfse-unavailable": "O PDF desta nota está disponível no Portal Nacional.",
          "danfse-layout-unavailable": "Baixe o DANFSe desta nota pelo Portal Nacional.",
        };
        setDownloadError((code && messages[code]) || errorMessage(failure));
      }
    } finally {
      download.current = null;
      if (!controller.signal.aborted) setDownloading(undefined);
    }
  }

  return (
    <div className="registry-card">
      <CollectionHeading icon="document" title={title} description="Histórico, documentos e cobranças em um só lugar.">
        {history && <PageCount count={history.items.length} page={page} />}
        <button className="button-secondary" disabled={Boolean(downloading) || (!history && !error)} onClick={() => setRetry((current) => current + 1)}><Icon name="repeat" />Atualizar</button>
        {customerId && <a href="#clientes">Voltar aos clientes</a>}
      </CollectionHeading>
      {error && <p className="registry-error" role="alert">{error}</p>}
      {downloadError && <p className="registry-error" role="alert">{downloadError}</p>}
      {(error || downloadError) && <button className="button-secondary" onClick={() => {
        setDownloadError("");
        setRetry((current) => current + 1);
      }}>Atualizar lista</button>}
      {!history && !error && <p role="status">Carregando notas…</p>}
      {history && history.items.length === 0 && <EmptyCollection icon="document" title="Nenhuma nota nesta página"
        description={customerId ? "As notas e DPS disponíveis deste cliente aparecerão aqui, com as opções de consulta e download." : "As notas emitidas aparecerão aqui. Use Nova nota avulsa para começar uma preparação."} />}
      {history && history.items.length > 0 && (
        <div className="registry-table compact-table collection-table">
          <table role="table" aria-label={customerId ? "Notas do cliente" : "Notas emitidas"}>
            <thead><tr><th scope="col">Data</th>{!customerId && <th scope="col">Cliente</th>}
              <th scope="col">Descrição</th><th scope="col">Valor</th><th scope="col">Situação</th><th scope="col">Documento</th></tr></thead>
            <tbody role="rowgroup">
              {history.items.map((item) => {
                const ownerCustomerId = customerId ?? item.customerId;
                const documentPath = ownerCustomerId ? customerInvoicesPath(ownerCustomerId) : undefined;
                const invoicePath = documentPath && documentPath + "/" + encodeURIComponent(item.id);
                const { dpsId, accessKey } = item;
                return (
                <tr role="row" key={item.id}>
                  <td role="cell" data-label="Data">{dateLabel(item.date)}</td>
                  {!customerId && <td role="cell" data-label="Cliente"><EntityTitle name={item.customerName ?? "Cliente"} /></td>}
                  <td role="cell" className="collection-description" data-label="Descrição">
                    <p>{item.serviceDescription.length > 130 ? item.serviceDescription.slice(0, 130) + "…" : item.serviceDescription}</p>
                    {item.serviceDescription.length > 130 && <details><summary>Ver descrição completa</summary><p>{item.serviceDescription}</p></details>}
                  </td>
                  <td role="cell" className="collection-money" data-label="Valor">{currency.format(Number(item.amount))}</td>
                  <td role="cell" data-label="Situação"><StatusPill tone={item.dpsId ? "info" : item.status === "AUTHORIZED" ? "positive" : ["CANCELLED", "FAILED", "REJECTED"].includes(item.status) ? "negative" : "warning"}>
                    {item.dpsId ? "DPS de teste assinada" : statusLabels[item.status]}</StatusPill></td>
                  <td role="cell" className="cell-wide" data-label="Documento">
                    <div className="collection-document-actions">
                    {documentPath && dpsId && <button type="button" className="button-secondary" disabled={Boolean(downloading)} onClick={() =>
                      void downloadDocument(dpsId, documentPath + "/dps/" + encodeURIComponent(dpsId) + ".pdf", "dps-teste-" + dpsId + ".pdf")}>
                      <Icon name="download" />
                      {downloading === dpsId ? "Preparando PDF…" : "Baixar PDF de teste"}
                    </button>}
                    {accessKey && (
                      <>
                        <div className="record-actions">
                          {invoicePath && item.hasXml && <button type="button" className="collection-primary-action" disabled={Boolean(downloading)} onClick={() =>
                            void downloadDocument(item.id + "-pdf", invoicePath + "/nfse.pdf", "danfse-" + accessKey + ".pdf")}>
                            <Icon name="download" />{downloading === item.id + "-pdf" ? "Preparando PDF…" : "Baixar PDF"}
                          </button>}
                          {invoicePath && item.hasXml && <button type="button" className="button-secondary" disabled={Boolean(downloading)} onClick={() =>
                            void downloadDocument(item.id + "-xml", invoicePath + "/nfse.xml", "nfse-" + accessKey + ".xml")}>
                            {downloading === item.id + "-xml" ? "Preparando XML…" : "XML"}
                          </button>}
                        </div>
                        {ownerCustomerId && item.hasXml && <a className="button button-secondary"
                          href={"#clientes?enviar=" + encodeURIComponent(ownerCustomerId) + "&tipo=INVOICE&documento=" + encodeURIComponent(item.id)}>
                          <Icon name="message" />Enviar ao cliente
                        </a>}
                        <a className="collection-portal" href={"https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=" + encodeURIComponent(accessKey)}
                          target="_blank" rel="noreferrer"><Icon name="external" />Consultar no Portal Nacional</a>
                        <details><summary>Chave de acesso</summary><code className="invoice-access-key">{accessKey}</code></details>
                      </>
                    )}
                    {canViewBilling && (item.status === "DRAFT" || item.status === "AUTHORIZED") &&
                      <a className="collection-billing-link" href={"#boletos?nota=" + encodeURIComponent(item.id)}>Ver cobrança<Icon name="arrow" /></a>}
                    {!item.dpsId && !item.accessKey && !(canViewBilling && (item.status === "DRAFT" || item.status === "AUTHORIZED")) && "—"}
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {history && history.items.length > 0 && <p className="collection-page-note"><Icon name="shield" />Os documentos são disponibilizados conforme o retorno fiscal. A consulta e o download não emitem novas notas.</p>}
      {history && (page > 1 || history.hasNext) && (
        <div className="record-actions registry-pagination">
          <button className="button-secondary" disabled={page === 1 || Boolean(downloading)} onClick={() => setPage(page - 1)}>Anterior</button>
          <span>Página {page}</span>
          <button className="button-secondary" disabled={!history.hasNext || page >= 10000 || Boolean(downloading)} onClick={() => setPage(page + 1)}>Próxima</button>
        </div>
      )}
    </div>
  );
}
