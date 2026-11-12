import { z } from "zod";
import { prestadorDpsId, type DpsEnvironment } from "./documents.ts";
import { FiscalError } from "./errors.ts";

const cnpj = z.string().regex(/^[0-9A-Z]{12}[0-9]{2}$/);
const city = z.string().regex(/^[0-9]{7}$/);
const money = z.string().regex(/^(0|[1-9][0-9]{0,14})(\.[0-9]{2})?$/);
const percent = z.string().regex(/^(0|[1-9][0-9]{0,2})(\.[0-9]{2})?$/);
const domesticAddress = z.strictObject({
  municipality: city,
  zipCode: z.string().regex(/^[0-9]{8}$/),
  street: z.string().trim().min(1).max(255),
  number: z.string().trim().min(1).max(60),
  complement: z.string().trim().min(1).max(156).optional(),
  neighborhood: z.string().trim().min(1).max(60),
});
const totals = z.union([
  z.strictObject({ indTotTrib: z.literal("0") }),
  z.strictObject({ pTotTribSN: z.string().regex(/^(0|[1-9][0-9]?)(\.[0-9]{2})?$/) }),
  z.strictObject({ pTotTrib: z.strictObject({ federal: percent, estadual: percent, municipal: percent }) }),
  z.strictObject({ vTotTrib: z.strictObject({ federal: money, estadual: money, municipal: money }) }),
]);
const draft = z.strictObject({
  cnpjPrestador: cnpj,
  cLocEmi: city,
  serie: z.string().regex(/^(?:[0-9]{1,4}|[0-4][0-9]{4})$/),
  nDPS: z.string().regex(/^[1-9][0-9]{0,14}$/),
  dCompet: z.iso.date(),
  inscricaoMunicipal: z.string().trim().min(1).max(15).optional(),
  opSimpNac: z.enum(["1", "2", "3"]),
  regApTribSN: z.enum(["1", "2", "3"]).optional(),
  regEspTrib: z.enum(["0", "1", "2", "3", "4", "5", "6", "9"]),
  tomador: z.strictObject({
    documento: z.union([cnpj, z.string().regex(/^[0-9]{11}$/)]),
    nome: z.string().trim().min(1).max(300),
    address: domesticAddress.optional(),
  }).optional(),
  cLocPrestacao: city,
  cTribNac: z.string().regex(/^[0-9]{6}$/),
  cTribMun: z.string().regex(/^[0-9]{3}$/).optional(),
  cNBS: z.string().regex(/^[0-9]{9}$/).optional(),
  xDescServ: z.string().trim().min(1).max(2000),
  vServ: money.refine((value) => Number(value) > 0),
  tpRetISSQN: z.enum(["1", "2"]),
  pAliq: z.string().regex(/^[0-9](\.[0-9]{2})?$/).optional(),
  totTrib: totals,
});

type DpsDraft = z.infer<typeof draft>;
const dpsPreparationInput = draft.omit({
  cnpjPrestador: true, cLocEmi: true, inscricaoMunicipal: true, tomador: true, xDescServ: true, vServ: true,
});
export const homologationDpsPreparationInput = dpsPreparationInput.extend({
  omitIssuerMunicipalRegistration: z.literal(true).optional(),
});
export const productionDpsPreparationInput = dpsPreparationInput.extend({
  buyerAddress: domesticAddress.optional(),
});
export const productionDpsSigningInput = productionDpsPreparationInput.extend({
  rememberFiscalData: z.literal(true).optional(),
});
export const dpsFiscalTemplate = productionDpsPreparationInput.omit({ nDPS: true, dCompet: true })
  .refine(({ totTrib }) => !("vTotTrib" in totTrib));

export const dpsDraftTemplate = {
  cnpjPrestador: "",
  cLocEmi: "",
  serie: "",
  nDPS: "",
  dCompet: "",
  opSimpNac: "",
  regEspTrib: "",
  cLocPrestacao: "",
  cTribNac: "",
  xDescServ: "",
  vServ: "",
  tpRetISSQN: "",
  totTrib: { pTotTrib: { federal: "", estadual: "", municipal: "" } },
};

export function readDpsDraft(file: Buffer): DpsDraft {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file));
  } catch {
    throw new FiscalError("invalid-dps-data", "O arquivo de dados deve ser um JSON válido em UTF-8.");
  }
  return parseDpsDraft(json);
}

export function parseDpsDraft(input: unknown): DpsDraft {
  const result = draft.safeParse(input);
  if (!result.success) {
    const fields = new Set(result.error.issues.map(({ path }) => path[0]).filter((field) => typeof field === "string"));
    const label = fields.size ? ` Confira os campos ${[...fields].join(", ")}.` : "";
    throw new FiscalError("invalid-dps-data", `Preencha o modelo da DPS e mantenha os valores entre aspas.${label}`);
  }
  const data = result.data;
  if ((data.opSimpNac === "3") !== (data.regApTribSN !== undefined)) {
    throw new FiscalError("invalid-dps-data", "Informe regApTribSN somente para optante do Simples Nacional ME/EPP.");
  }
  if (data.tpRetISSQN === "2" && !data.tomador) {
    throw new FiscalError("invalid-dps-data", "Informe o tomador para indicar retenção pelo tomador.");
  }
  if (("indTotTrib" in data.totTrib && data.opSimpNac !== "2") ||
      ("pTotTribSN" in data.totTrib && data.opSimpNac !== "3")) {
    throw new FiscalError("invalid-dps-data", "Use indTotTrib para MEI ou pTotTribSN para ME/EPP, conforme o regime aplicável.");
  }
  return data;
}

const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const brasiliaDateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "longOffset",
});

function field(name: string, value: string | undefined) {
  return value === undefined ? "" : `<${name}>${value.replace(/[&<>]/g, (char) => entities[char])}</${name}>`;
}

function taxTotals(values: DpsDraft["totTrib"]) {
  if ("indTotTrib" in values) return field("indTotTrib", values.indTotTrib);
  if ("pTotTribSN" in values) return field("pTotTribSN", values.pTotTribSN);
  const prefix = "pTotTrib" in values ? "pTotTrib" : "vTotTrib";
  const amounts = "pTotTrib" in values ? values.pTotTrib : values.vTotTrib;
  return `<${prefix}>${field(prefix + "Fed", amounts.federal)}${field(prefix + "Est", amounts.estadual)}${field(prefix + "Mun", amounts.municipal)}</${prefix}>`;
}

export function createUnsignedDps(data: DpsDraft, issuedAt = new Date(), environment: DpsEnvironment = "HOMOLOGATION") {
  const id = prestadorDpsId(data.cLocEmi, data.cnpjPrestador, data.serie, data.nDPS);
  const parts = Object.fromEntries(brasiliaDateTime.formatToParts(issuedAt).map(({ type, value }) => [type, value]));
  const offset = parts.timeZoneName.slice(3) || "+00:00";
  const dateTime = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
  const buyer = data.tomador;
  const address = buyer?.address;
  const buyerAddress = address ? "<end><endNac>" + field("cMun", address.municipality) + field("CEP", address.zipCode) +
    "</endNac>" + field("xLgr", address.street) + field("nro", address.number) + field("xCpl", address.complement) +
    field("xBairro", address.neighborhood) + "</end>" : "";
  const homologation = environment === "HOMOLOGATION";
  const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
    `<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infDPS Id="${id}">` +
    `<tpAmb>${homologation ? "2" : "1"}</tpAmb><dhEmi>${dateTime}</dhEmi><verAplic>Fiscal Floow</verAplic>` +
    field("serie", data.serie) + field("nDPS", data.nDPS) + field("dCompet", data.dCompet) +
    "<tpEmit>1</tpEmit>" + (homologation ? "<finNFSe>0</finNFSe>" : "") + field("cLocEmi", data.cLocEmi) +
    "<prest>" + field("CNPJ", data.cnpjPrestador) + field("IM", data.inscricaoMunicipal) +
    "<regTrib>" + field("opSimpNac", data.opSimpNac) + field("regApTribSN", data.regApTribSN) +
    field("regEspTrib", data.regEspTrib) + "</regTrib></prest>" +
    (buyer ? "<toma>" + field(buyer.documento.length === 11 ? "CPF" : "CNPJ", buyer.documento) +
      field("xNome", buyer.nome) + buyerAddress + "</toma>" : "") +
    "<serv><locPrest>" + field("cLocPrestacao", data.cLocPrestacao) + "</locPrest><cServ>" +
    field("cTribNac", data.cTribNac) + field("cTribMun", data.cTribMun) + field("cNBS", data.cNBS) +
    field("xDescServ", data.xDescServ) + "</cServ></serv>" +
    "<valores><vServPrest>" + field("vServ", data.vServ) + "</vServPrest><trib>" +
    "<tribMun><tribISSQN>1</tribISSQN>" + field("tpRetISSQN", data.tpRetISSQN) + field("pAliq", data.pAliq) +
    "</tribMun><totTrib>" + taxTotals(data.totTrib) + "</totTrib></trib></valores></infDPS></DPS>";
  return Buffer.from(xml, "utf8");
}
