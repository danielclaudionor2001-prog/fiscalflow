import type { RecordData } from "./api";
import { contactNumber, contactNumberLabel, emailLink, whatsappLink } from "./contact";
import { Icon } from "../ui";
import type { Field } from "./form";

export const customerResponsibleFields: Field[] = [
  { name: "contactName", label: "Nome do responsável", section: "Responsável pelo cliente", maxLength: 160 },
  { name: "contactWhatsapp", label: "WhatsApp do responsável", kind: "tel", maxLength: 32,
    hint: "Opcional. Informe DDD e número. Para outro país, use + e o código do país." },
  { name: "contactPhone", label: "Telefone alternativo do responsável", kind: "tel", maxLength: 32,
    hint: "Opcional. Pode ser fixo ou celular, mesmo sem WhatsApp. Informe o DDD." },
  { name: "contactEmail", label: "E-mail do responsável", kind: "email", maxLength: 254,
    hint: "Opcional. Você pode cadastrar só e-mail, só WhatsApp ou os dois." },
];

export function CustomerContact({ customer }: { customer: RecordData }) {
  const whatsapp = whatsappLink(customer.contactWhatsapp);
  const phone = contactNumber(customer.contactPhone);
  const email = emailLink(customer.contactEmail);
  return <div className="customer-contact">
    {customer.contactName && <strong>{customer.contactName}</strong>}
    {whatsapp && <a className="customer-whatsapp" href={whatsapp} target="_blank" rel="noopener noreferrer"
      aria-label={`Abrir WhatsApp de ${customer.contactName || customer.name}`}><Icon name="message" />WhatsApp · {contactNumberLabel(customer.contactWhatsapp)}</a>}
    {phone && <a href={"tel:+" + phone}><Icon name="phone" />{contactNumberLabel(customer.contactPhone)}</a>}
    {email && <a href={email}><Icon name="email" />{customer.contactEmail}</a>}
    {!customer.contactName && !whatsapp && !phone && !email && <span>Responsável não informado</span>}
  </div>;
}
