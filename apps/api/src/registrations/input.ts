import { z } from "zod";
import { addressFields, contactFields, ibsCbsFields, municipalServiceCode, nationalServiceCode, nbsCode, organizationTaxFields } from "./profile-input.ts";

const requiredText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).transform((text) => text || null).nullable().optional();

const cnpjPattern = /^[A-Z0-9]{12}\d{2}$/;
const normalizeDocument = (value: string) => value.replace(/[./-]/g, "").toUpperCase();
const document = z.string().trim().max(32).regex(/^[A-Za-z0-9./-]+$/).transform(normalizeDocument);
export const cnpjSchema = document.refine((value) => cnpjPattern.test(value));
export const cpfFormatSchema = document.refine((value) => /^\d{11}$/.test(value));
const federalTaxId = z.union([cpfFormatSchema, cnpjSchema]);

export const cpfSchema = cpfFormatSchema.refine((value) => {
  if (/^(\d)\1{10}$/.test(value)) return false;
  const digits = Array.from(value, Number);
  return [9, 10].every((length) => {
    const sum = digits.slice(0, length).reduce((total, digit, index) => total + digit * (length + 1 - index), 0);
    return (sum * 10 % 11) % 10 === digits[length];
  });
});
export const organizationDocumentSchema = z.union([cpfSchema, cnpjSchema]);

export function organizationDocumentView({ cnpj, cpf }: { cnpj: string | null; cpf: string | null }) {
  return {
    cnpj,
    documentType: cpf ? "CPF" : "CNPJ",
    cpfMasked: cpf ? "***.***.***-" + cpf.slice(-2) : null,
  };
}

const organization = z.strictObject({
  legalName: requiredText(160),
  tradeName: optionalText(160),
  municipalRegistration: optionalText(40),
  cityIbgeCode: z.string().trim().regex(/^\d{7}$/).nullable().optional(),
  ...addressFields,
  ...organizationTaxFields,
  stateRegistration: optionalText(40),
  legalRepresentativeName: optionalText(160),
  legalRepresentativeCpf: cpfSchema.nullable().optional(),
  legalRepresentativeEmail: z.string().trim().max(254).pipe(z.email()).nullable().optional(),
  legalRepresentativePhone: optionalText(32),
});

export const organizationCreate = organization.extend({ cnpj: cnpjSchema });
export const organizationSubscriberCreate = organization.extend({ cnpj: cnpjSchema.optional(), cpf: cpfSchema.optional() })
  .refine(({ cnpj, cpf }) => Boolean(cnpj) !== Boolean(cpf));
export const organizationUpdate = organization.partial().refine((data) => Object.keys(data).length > 0);

export const customerCreate = z.strictObject({
  name: requiredText(160),
  federalTaxId,
  email: z.string().trim().max(254).pipe(z.email()).nullable().optional(),
  phone: optionalText(32),
  ...addressFields,
  ...contactFields,
  cityIbgeCode: z.string().trim().regex(/^\d{7}$/).nullable().optional(),
  municipalRegistration: optionalText(40),
  stateRegistration: optionalText(40),
});
export const customerUpdate = customerCreate.partial().refine((data) => Object.keys(data).length > 0);

export const moneyAmount = z.string().trim().regex(/^(0|[1-9]\d{0,11})([.,]\d{1,2})?$/)
  .transform((amount) => amount.replace(",", "."));

export const serviceCreate = z.strictObject({
  name: requiredText(160),
  description: requiredText(2000),
  nationalServiceCode,
  municipalServiceCode,
  nbsCode,
  ...ibsCbsFields,
  operationIndicator: z.string().trim().regex(/^\d{6}$/).nullable().optional(),
  defaultAmount: moneyAmount,
  active: z.boolean().optional(),
});
export const serviceUpdate = serviceCreate.partial().refine((data) => Object.keys(data).length > 0);

const positiveInteger = z.string().regex(/^[1-9]\d*$/).transform(Number);
export const pagination = z.strictObject({
  page: positiveInteger.pipe(z.number().int().max(10000)).optional().default(1),
  limit: positiveInteger.pipe(z.number().int().max(100)).optional().default(25),
});
export const recordId = requiredText(128);
