import { useEffect, useRef, useState } from "react";
import { normalizeDocument } from "../format";
import { DocumentInput } from "../formatted-inputs";
import { jsonMutation, RegistrationError, type useRegistrationRequest } from "../registrations/api";
import { CatalogPicker } from "./catalog-picker";

export type InvoiceCustomerValue = { customerId: string } | { customerCnpj: string; customerName: string };
type CustomerPickerProps = {
  request: ReturnType<typeof useRegistrationRequest>;
  onChange: (customer: InvoiceCustomerValue | undefined) => void;
};
type Lookup =
  | { source: "registered"; customerId: string; name: string }
  | { source: "public"; name: string }
  | { source: "not-found" | "unavailable" };

function CnpjCustomer({ request, onChange }: CustomerPickerProps) {
  const [cnpj, setCnpj] = useState("");
  const [lookup, setLookup] = useState<Lookup>();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  const complete = /^[A-Z0-9]{12}\d{2}$/.test(cnpj);

  useEffect(() => {
    if (!complete) return;
    const controller = new AbortController();
    pending.current = controller;
    const timer = window.setTimeout(async () => {
      try {
        const result = await request<Lookup>("invoices/customer-lookup", {
          ...jsonMutation("POST", { cnpj }), signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setLookup(result);
        if (result.source === "registered") onChange({ customerId: result.customerId });
        if (result.source === "public") {
          setName(result.name);
          onChange({ customerCnpj: cnpj, customerName: result.name });
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure instanceof RegistrationError) {
          if (failure.code === "invalid-cnpj" || failure.status === 400) {
            setError("Confira os dígitos do CNPJ.");
            return;
          }
          if (failure.code === "customer-archived") {
            setError("Este cliente está arquivado. Selecione outro cliente para a nota.");
            return;
          }
          if (failure.status === 403) {
            setError("Seu acesso não permite consultar clientes para emissão.");
            return;
          }
        }
        setLookup({ source: "unavailable" });
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [cnpj, complete, onChange, request]);

  return <>
    <label>CNPJ do cliente
      <DocumentInput mode="cnpj" required maxLength={18} autoComplete="off" onDocumentChange={(value) => {
        const document = normalizeDocument(value);
        if (document === cnpj) return;
        pending.current?.abort();
        setCnpj(document);
        setLookup(undefined);
        setError("");
        setName("");
        onChange(undefined);
      }} />
    </label>
    <div className="invoice-customer-status" role="status">
      {complete && !lookup && !error && "Buscando cliente…"}
      {lookup?.source === "registered" && <><strong>{lookup.name}</strong> · Cliente cadastrado</>}
      {lookup?.source === "public" && "Razão social encontrada na BrasilAPI. Confira antes de continuar."}
      {lookup?.source === "not-found" && "CNPJ sem resultado na consulta. Informe a razão social para continuar."}
      {lookup?.source === "unavailable" && "Consulta indisponível. Informe a razão social para continuar."}
    </div>
    {error && <p role="alert" className="registry-error">{error}</p>}
    {lookup && lookup.source !== "registered" && <label>Razão social
      <input value={name} required maxLength={160} autoComplete="organization" onChange={(event) => {
        const customerName = event.target.value.trim();
        setName(event.target.value);
        onChange(customerName ? { customerCnpj: cnpj, customerName } : undefined);
      }} />
    </label>}
  </>;
}

export function InvoiceCustomer({ request, onChange }: CustomerPickerProps) {
  const [byName, setByName] = useState(false);
  const [customerId, setCustomerId] = useState("");
  return <div className="invoice-customer">
    <div className="invoice-customer-heading">
      <strong>Tomador da nota</strong>
      <button type="button" className="button-link" onClick={() => {
        setByName(!byName);
        setCustomerId("");
        onChange(undefined);
      }}>{byName ? "Buscar pelo CNPJ" : "Buscar pelo nome"}</button>
    </div>
    {byName
      ? <CatalogPicker request={request} resource="customers" label="Cliente" value={customerId} onChange={(option) => {
        setCustomerId(option?.id ?? "");
        onChange(option ? { customerId: option.id } : undefined);
      }} />
      : <CnpjCustomer request={request} onChange={onChange} />}
  </div>;
}
