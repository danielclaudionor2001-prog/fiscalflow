import type { RecordData } from "./api";
import { contactNumber, contactNumberLabel, emailLink, whatsappLink } from "./contact";
import { Icon } from "../ui";

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
