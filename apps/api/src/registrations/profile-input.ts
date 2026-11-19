import { z } from "zod";

export const optionalText = (max: number) => z.string().trim().max(max).transform((value) => value || null).nullable().optional();
const optionalCode = (pattern: RegExp) => z.string().trim().max(32)
  .transform((value) => value.replace(/[.\s/-]/g, ""))
  .pipe(z.string().regex(pattern)).nullable().optional();
const optionalEmail = z.string().trim().max(254).pipe(z.email()).nullable().optional();

export const addressFields = {
  zipCode: optionalCode(/^\d{8}$/),
  street: optionalText(255),
  addressNumber: optionalText(60),
  addressComplement: optionalText(156),
  neighborhood: optionalText(60),
  cityName: optionalText(100),
  state: z.enum(["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG",
    "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"]).nullable().optional(),
};

export const contactFields = {
  contactName: optionalText(160),
  financialContactName: optionalText(160),
  financialContactEmail: optionalEmail,
  financialContactPhone: optionalText(32),
};

export const ibsCbsFields = {
  ibsCbsCst: optionalCode(/^\d{3}$/),
  ibsCbsClassCode: optionalCode(/^\d{6}$/),
};
export const nbsCode = optionalCode(/^\d{9}$/);
export const nationalServiceCode = optionalCode(/^\d{6}$/);
export const municipalServiceCode = optionalCode(/^\d{3}$/);
export const productTaxFields = {
  ...ibsCbsFields,
  ncmCode: optionalCode(/^\d{8}$/),
  cfopCode: optionalCode(/^\d{4}$/),
  icmsCst: optionalCode(/^\d{2}$/),
  csosnCode: optionalCode(/^\d{3}$/),
};

export const organizationTaxFields = {
  taxRegime: z.enum(["MEI", "SIMPLES_NACIONAL", "LUCRO_PRESUMIDO", "LUCRO_REAL", "IMUNE_ISENTA", "OUTRO"]).nullable().optional(),
  simplesApportionment: z.enum(["1", "2", "3"]).nullable().optional(),
  specialTaxRegime: z.enum(["0", "1", "2", "3", "4", "5", "6", "9"]).nullable().optional(),
};

export const fiscalProfileIsConsistent = (input: { ibsCbsCst?: string | null; ibsCbsClassCode?: string | null }) =>
  !input.ibsCbsCst || !input.ibsCbsClassCode || input.ibsCbsClassCode.startsWith(input.ibsCbsCst);

export const optionalRate = z.string().trim().regex(/^(0|[1-9]\d{0,2})([.,]\d{1,4})?$/)
  .transform((value) => value.replace(",", ".")).refine((value) => Number(value) <= 100).nullable().optional();
