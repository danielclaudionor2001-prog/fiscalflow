import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { ParseOption, XmlBufferInputProvider, XmlDocument, XmlElement, XmlValidateError, XsdValidator, xmlRegisterInputProvider } from "libxml2-wasm";
import { SignedXml } from "xml-crypto";
import { inspectCertificate, type loadHomologationSigningKey } from "./certificate.ts";
import { FiscalError, maxXmlBytes } from "./errors.ts";

const namespaces = { n: "http://www.sped.fazenda.gov.br/nfse", ds: "http://www.w3.org/2000/09/xmldsig#" };
const xsdUrl = "https://fiscalflow.invalid/";
const noteSchemas = ["NFSe_v1.01.xsd", "tiposComplexos_v1.01.xsd", "tiposSimples_v1.01.xsd", "xmldsig-core-schema.xsd"];
const currentRevision = "20261020";
const previousRevision = "20260209";
export const productionDpsSchemaRevision = previousRevision;
export type DpsEnvironment = "HOMOLOGATION" | "PRODUCTION";
type Schema = "DPS_v1.01.xsd" | "NFSe_v1.01.xsd";
const schemaDirectory = new URL("../../fiscal-schemas/", import.meta.url);
const xmlOptions = { option: ParseOption.XML_PARSE_NO_XXE | ParseOption.XML_PARSE_NONET };

export const dpsIdPattern = /^DPS[0-9]{7}(?:1[0-9]{14}|2[0-9A-Z]{14})[0-9]{20}$/;
export const accessKeyPattern = /^[0-9]{9}[0-9A-Z]{14}[0-9]{27}$/;
const cnpjPattern = /^[0-9A-Z]{12}[0-9]{2}$/;
const canonical = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const enveloped = `${namespaces.ds}enveloped-signature`;
const rsaSha1 = `${namespaces.ds}rsa-sha1`;
const sha1 = `${namespaces.ds}sha1`;
const algorithms = new Map([
  [rsaSha1, sha1],
  ["http://www.w3.org/2001/04/xmldsig-more#rsa-sha256", "http://www.w3.org/2001/04/xmlenc#sha256"],
]);

let schemas: Record<string, Buffer> | undefined;

function loadSchemas() {
  if (schemas) return schemas;
  try {
    const files = [
      ...["DPS_v1.01.xsd", ...noteSchemas].map((name) => `sefin-${currentRevision}/${name}`),
      ...["DPS_v1.01.xsd", ...noteSchemas].map((name) => `sefin-${previousRevision}/${name}`),
    ];
    const buffers = Object.fromEntries(files.map((name) => [xsdUrl + name, readFileSync(new URL(name, schemaDirectory))]));
    const previousTypesUrl = `${xsdUrl}sefin-${previousRevision}/tiposSimples_v1.01.xsd`;
    // The February series pattern uses regex anchors that XML Schema reads as literal characters.
    // XML Schema already matches the whole value, so remove just those anchors in memory.
    buffers[previousTypesUrl] = Buffer.from(buffers[previousTypesUrl].toString("utf8")
      .replace(String.raw`value="^0{0,4}\d{1,5}$"`, String.raw`value="0{0,4}\d{1,5}"`));
    if (!xmlRegisterInputProvider(new XmlBufferInputProvider(buffers))) throw new Error();
    schemas = buffers;
    return buffers;
  } catch {
    throw new FiscalError("schema-unavailable", "O pacote oficial de esquemas da homologação está indisponível.");
  }
}

function validateSchema(doc: XmlDocument, schema: Schema, revision = currentRevision) {
  const url = `${xsdUrl}sefin-${revision}/${schema}`;
  const xsd = XmlDocument.fromBuffer(loadSchemas()[url], { url });
  try {
    const validator = XsdValidator.fromDoc(xsd);
    try {
      validator.validate(doc);
    } catch (error) {
      const elementos = error instanceof XmlValidateError
        ? error.details.slice(0, 6).map(({ message }) =>
          /^Element '\{http:\/\/www\.sped\.fazenda\.gov\.br\/nfse\}([A-Za-z][A-Za-z0-9]{0,39})'/.exec(message)?.[1],
        ).filter(Boolean)
        : [];
      throw new FiscalError("invalid-schema", "O XML não atende ao esquema oficial da NFS-e.", { revisao: revision, elementos });
    } finally {
      validator.dispose();
    }
  } finally {
    xsd.dispose();
  }
}

function parseXml(xml: Buffer) {
  try {
    if (!xml.length || xml.length > maxXmlBytes) throw new Error();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(xml);
    const declaration = text.match(/^<\?xml\s+[^?]*?encoding\s*=\s*["']([^"']+)["']/i);
    if ((declaration && declaration[1].toLowerCase() !== "utf-8") || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error();
    return { text, doc: XmlDocument.fromString(text, xmlOptions) };
  } catch {
    throw new FiscalError("invalid-xml", "Informe um XML UTF-8 bem formado, dentro do limite de tamanho e sem DTD.");
  }
}

function value(doc: XmlDocument, path: string) {
  return String(doc.eval(`string(${path})`, namespaces));
}

export function prestadorDpsId(city: string, cnpj: string, series: string, number: string) {
  return `DPS${city}2${cnpj}${series.padStart(5, "0")}${number.padStart(15, "0")}`;
}

function readDpsInfo(doc: XmlDocument, base: string, environment: DpsEnvironment = "HOMOLOGATION") {
  if (value(doc, `${base}/n:tpAmb`) !== (environment === "PRODUCTION" ? "1" : "2")) {
    throw new FiscalError("environment-not-allowed", "O ambiente no XML da DPS diverge da operação solicitada.");
  }
  const cnpj = value(doc, `${base}/n:prest/n:CNPJ`);
  if (value(doc, `${base}/n:tpEmit`) !== "1" || !cnpjPattern.test(cnpj) || doc.get(`${base}/n:subst`, namespaces)) {
    throw new FiscalError("unsupported-dps", "O fluxo aceita DPS regular emitida pelo prestador e-CNPJ, sem substituição.");
  }
  const id = value(doc, `${base}/@Id`);
  const city = value(doc, `${base}/n:cLocEmi`);
  const series = value(doc, `${base}/n:serie`);
  const number = value(doc, `${base}/n:nDPS`);
  if (!dpsIdPattern.test(id) || id !== prestadorDpsId(city, cnpj, series, number)) {
    throw new FiscalError("invalid-dps-id", "O Id da DPS diverge de município, CNPJ, série ou número do documento.");
  }
  return { id, cnpj };
}

function invalidSignature() {
  return new FiscalError("invalid-signature", "Informe uma DPS assinada com XMLDSig válido sobre o infDPS.");
}

function signDps(unsigned: Buffer, key: ReturnType<typeof loadHomologationSigningKey>, environment: DpsEnvironment) {
  const { text, doc } = parseXml(unsigned);
  try {
    validateSchema(doc, "DPS_v1.01.xsd", environment === "PRODUCTION" ? productionDpsSchemaRevision : currentRevision);
    if (value(doc, "/n:DPS/@versao") !== "1.01") {
      throw new FiscalError("unsupported-layout", "Use o leiaute de DPS versão 1.01.");
    }
    const { cnpj } = readDpsInfo(doc, "/n:DPS/n:infDPS", environment);
    if (cnpj !== key.cnpj) {
      throw new FiscalError("certificate-holder-mismatch", "O CNPJ informado para o prestador diverge do e-CNPJ A1.");
    }
    if (doc.get("/n:DPS/ds:Signature", namespaces)) throw invalidSignature();
  } finally {
    doc.dispose();
  }

  const signer = new SignedXml({
    privateKey: key.privateKey,
    publicCert: key.publicCert,
    signatureAlgorithm: rsaSha1,
    canonicalizationAlgorithm: canonical,
  });
  signer.addReference({
    xpath: "/*[local-name()='DPS']/*[local-name()='infDPS']",
    digestAlgorithm: sha1,
    transforms: [enveloped, canonical],
  });
  try {
    signer.computeSignature(text, { location: { reference: "/*", action: "append" } });
  } catch {
    throw new FiscalError("signing-failed", "Não foi possível assinar a DPS com o e-CNPJ A1 informado.");
  }
  const xml = Buffer.from(signer.getSignedXml(), "utf8");
  const { id } = validateSignedDps(xml, environment);
  return { id, xml };
}

export const signHomologationDps = (unsigned: Buffer, key: ReturnType<typeof loadHomologationSigningKey>) => signDps(unsigned, key, "HOMOLOGATION");
export const signProductionDps = (unsigned: Buffer, key: ReturnType<typeof loadHomologationSigningKey>) => signDps(unsigned, key, "PRODUCTION");
export const validateDps = (xml: Buffer) => validateSignedDps(xml, "HOMOLOGATION");
export const validateProductionDps = (xml: Buffer) => validateSignedDps(xml, "PRODUCTION");

function validateSignedDps(xml: Buffer, environment: DpsEnvironment) {
  const { text, doc } = parseXml(xml);
  try {
    if (xml[0] !== 0x3c || !/^<\?xml\s+version\s*=\s*(["'])1\.0\1\s+encoding\s*=\s*(["'])UTF-8\2/i.test(text)) {
      throw new FiscalError("missing-xml-declaration", "A DPS deve começar com a declaração XML 1.0 em UTF-8. Gere o XML novamente.");
    }
    validateSchema(doc, "DPS_v1.01.xsd", environment === "PRODUCTION" ? productionDpsSchemaRevision : currentRevision);
    const base = "/n:DPS/n:infDPS";
    if (value(doc, "/n:DPS/@versao") !== "1.01") {
      throw new FiscalError("unsupported-layout", "Use o leiaute de DPS versão 1.01.");
    }
    const info = readDpsInfo(doc, base, environment);
    const path = "/n:DPS/ds:Signature";
    const signature = doc.get(path, namespaces);
    const signedInfo = `${path}/ds:SignedInfo`;
    const reference = `${signedInfo}/ds:Reference`;
    const key = `${path}/ds:KeyInfo/ds:X509Data/ds:X509Certificate`;
    const transforms = `${reference}/ds:Transforms/ds:Transform`;
    const algorithm = value(doc, `${signedInfo}/ds:SignatureMethod/@Algorithm`);
    if (!(signature instanceof XmlElement) ||
        doc.find("//ds:Signature", namespaces).length !== 1 ||
        doc.find(reference, namespaces).length !== 1 ||
        doc.find(key, namespaces).length !== 1 ||
        doc.find(transforms, namespaces).length !== 2 ||
        value(doc, `${reference}/@URI`) !== `#${info.id}` ||
        value(doc, `${transforms}[1]/@Algorithm`) !== enveloped ||
        value(doc, `${transforms}[2]/@Algorithm`) !== canonical ||
        value(doc, `${signedInfo}/ds:CanonicalizationMethod/@Algorithm`) !== canonical ||
        algorithms.get(algorithm) !== value(doc, `${reference}/ds:DigestMethod/@Algorithm`)) throw invalidSignature();

    let certificate: X509Certificate;
    let verified: string;
    try {
      certificate = new X509Certificate(Buffer.from(value(doc, key), "base64"));
      const verifier = new SignedXml({ publicCert: certificate.toString(), getCertFromKeyInfo: () => null });
      verifier.loadSignature(signature.canonicalizeToString());
      if (!verifier.checkSignature(text)) throw invalidSignature();
      const references = verifier.getSignedReferences();
      if (references.length !== 1) throw invalidSignature();
      [verified] = references;
    } catch {
      throw invalidSignature();
    }

    const identity = inspectCertificate(certificate, "signature");
    const signed = XmlDocument.fromString(verified, xmlOptions);
    try {
      const actual = readDpsInfo(signed, "/n:infDPS", environment);
      if (actual.id !== info.id || actual.cnpj !== info.cnpj || identity.cnpj !== actual.cnpj) {
        throw new FiscalError("certificate-holder-mismatch", "O CNPJ do certificado de assinatura diverge do prestador da DPS.");
      }
      return { ...actual, fingerprint: identity.fingerprint };
    } finally {
      signed.dispose();
    }
  } finally {
    doc.dispose();
  }
}

export function readLocalDpsSummary(xml: Buffer, environment: DpsEnvironment = "HOMOLOGATION") {
  const { doc } = parseXml(xml);
  const base = "/n:DPS/n:infDPS";
  try {
    const { id, cnpj } = readDpsInfo(doc, base, environment);
    return {
      id, cnpj,
      series: value(doc, base + "/n:serie"),
      number: value(doc, base + "/n:nDPS"),
      competence: value(doc, base + "/n:dCompet"),
      issuedAt: value(doc, base + "/n:dhEmi"),
      issuerCity: value(doc, base + "/n:cLocEmi"),
      issuerName: value(doc, base + "/n:prest/n:xNome"),
      issuerRegistration: value(doc, base + "/n:prest/n:IM"),
      customerName: value(doc, base + "/n:toma/n:xNome"),
      customerDocument: value(doc, base + "/n:toma/n:CNPJ | " + base + "/n:toma/n:CPF"),
      customerRegistration: value(doc, base + "/n:toma/n:IM"),
      serviceCity: value(doc, base + "/n:serv/n:locPrest/n:cLocPrestacao"),
      serviceCode: value(doc, base + "/n:serv/n:cServ/n:cTribNac"),
      municipalServiceCode: value(doc, base + "/n:serv/n:cServ/n:cTribMun"),
      nbs: value(doc, base + "/n:serv/n:cServ/n:cNBS"),
      description: value(doc, base + "/n:serv/n:cServ/n:xDescServ"),
      amount: value(doc, base + "/n:valores/n:vServPrest/n:vServ"),
      issRetention: value(doc, base + "/n:valores/n:trib/n:tribMun/n:tpRetISSQN"),
      issRate: value(doc, base + "/n:valores/n:trib/n:tribMun/n:pAliq"),
      additionalInfo: value(doc, base + "/n:serv/n:infoCompl/n:xInfComp"),
      ...(environment === "PRODUCTION" && {
        taxRegime: value(doc, base + "/n:prest/n:regTrib/n:opSimpNac"),
        simplesAssessment: value(doc, base + "/n:prest/n:regTrib/n:regApTribSN"),
        specialRegime: value(doc, base + "/n:prest/n:regTrib/n:regEspTrib"),
        simplesTotal: value(doc, base + "/n:valores/n:trib/n:totTrib/n:pTotTribSN"),
      }),
    };
  } finally {
    doc.dispose();
  }
}

export function assertPreparedDpsMatchesNote(prepared: Buffer, nfse: Buffer, environment: DpsEnvironment = "HOMOLOGATION") {
  const original = readLocalDpsSummary(prepared, environment);
  const { doc } = parseXml(nfse);
  const base = "/n:NFSe/n:infNFSe/n:DPS/n:infDPS";
  try {
    const returned = readDpsInfo(doc, base, environment);
    const customer = value(doc, `${base}/n:toma/n:CNPJ | ${base}/n:toma/n:CPF`);
    const checks = {
      id: returned.id === original.id,
      prestador: returned.cnpj === original.cnpj,
      dhEmi: Date.parse(value(doc, `${base}/n:dhEmi`)) === Date.parse(original.issuedAt),
      dCompet: value(doc, `${base}/n:dCompet`) === original.competence,
      tomador: customer === original.customerDocument,
      cTribNac: value(doc, `${base}/n:serv/n:cServ/n:cTribNac`) === original.serviceCode,
      xDescServ: value(doc, `${base}/n:serv/n:cServ/n:xDescServ`) === original.description,
      vServ: Number(value(doc, `${base}/n:valores/n:vServPrest/n:vServ`)) === Number(original.amount),
      ...(environment === "PRODUCTION" && {
        cLocPrestacao: value(doc, `${base}/n:serv/n:locPrest/n:cLocPrestacao`) === original.serviceCity,
        cTribMun: value(doc, `${base}/n:serv/n:cServ/n:cTribMun`) === original.municipalServiceCode,
        cNBS: value(doc, `${base}/n:serv/n:cServ/n:cNBS`) === original.nbs,
        tpRetISSQN: value(doc, `${base}/n:valores/n:trib/n:tribMun/n:tpRetISSQN`) === original.issRetention,
        opSimpNac: value(doc, `${base}/n:prest/n:regTrib/n:opSimpNac`) === original.taxRegime,
        regApTribSN: value(doc, `${base}/n:prest/n:regTrib/n:regApTribSN`) === original.simplesAssessment,
      }),
    };
    const camposDivergentes = Object.keys(checks).filter((field) => !checks[field as keyof typeof checks]);
    if (camposDivergentes.length) {
      throw new FiscalError("response-mismatch", "A NFS-e retornada não corresponde à DPS preparada.",
        { etapa: "conferir-dps", camposDivergentes });
    }
  } finally {
    doc.dispose();
  }
}

function verifyRetrievedNoteSignature(doc: XmlDocument, text: string, accessKey: string) {
  const path = "/n:NFSe/ds:Signature";
  const reference = path + "/ds:SignedInfo/ds:Reference";
  const signature = doc.get(path, namespaces);
  if (!(signature instanceof XmlElement) || doc.find(path, namespaces).length !== 1 ||
      doc.find(reference, namespaces).length !== 1 || value(doc, reference + "/@URI") !== `#NFS${accessKey}`) {
    throw invalidSignature();
  }
  try {
    const key = value(doc, path + "/ds:KeyInfo/ds:X509Data/ds:X509Certificate[1]");
    const certificate = new X509Certificate(Buffer.from(key, "base64"));
    const verifier = new SignedXml({ publicCert: certificate.toString(), getCertFromKeyInfo: () => null });
    verifier.loadSignature(signature.canonicalizeToString());
    if (!verifier.checkSignature(text) || verifier.getSignedReferences().length !== 1) throw invalidSignature();
  } catch {
    throw invalidSignature();
  }
}

export function validateReturnedNfse(xml: Buffer, accessKey: string, expectedDps?: string, retrievedByKey = false) {
  const { doc, text } = parseXml(xml);
  try {
    const info = "/n:NFSe/n:infNFSe";
    const dps = `${info}/n:DPS/n:infDPS`;
    const dpsId = value(doc, `${dps}/@Id`);
    if (value(doc, `${info}/@Id`) !== `NFS${accessKey}` ||
        value(doc, `${dps}/n:tpAmb`) !== "2" ||
        !dpsIdPattern.test(dpsId) ||
        (expectedDps !== undefined && expectedDps !== dpsId)) {
      throw new FiscalError("response-mismatch", "O XML retornado diverge da chave, da DPS ou do ambiente consultado.");
    }
    try {
      validateSchema(doc, "NFSe_v1.01.xsd");
    } catch (currentError) {
      if (!(currentError instanceof FiscalError) || currentError.code !== "invalid-schema") throw currentError;
      try {
        validateSchema(doc, "NFSe_v1.01.xsd", previousRevision);
      } catch (previousError) {
        if (!(previousError instanceof FiscalError) || previousError.code !== "invalid-schema") throw previousError;
        const diagnostico = {
          esquemas: [currentError.diagnostico, previousError.diagnostico],
        };
        if (!retrievedByKey || !expectedDps || value(doc, "/n:NFSe/@versao") !== "1.01" ||
            doc.find(info, namespaces).length !== 1 || doc.find(dps, namespaces).length !== 1 ||
            value(doc, `${info}/n:cStat`) !== "100" || !/^[1-9][0-9]{0,12}$/.test(value(doc, `${info}/n:nNFSe`))) {
          throw new FiscalError("invalid-schema", "O XML retornado não atende aos esquemas oficiais suportados.", diagnostico);
        }
        try {
          // The caller has checked the SEFIN TLS endpoint and homologation envelope.
          // Validate the authority's signed infNFSe when releases use different schemas.
          verifyRetrievedNoteSignature(doc, text, accessKey);
        } catch {
          throw new FiscalError("invalid-signature", "A assinatura do XML recuperado da SEFIN não pôde ser verificada.", diagnostico);
        }
      }
    }
    return { dpsId, accessKey, xml };
  } finally {
    doc.dispose();
  }
}

export function readProductionNfse(xml: Buffer, accessKey: string, cnpj: string) {
  const { doc } = parseXml(xml);
  try {
    const info = "/n:NFSe/n:infNFSe";
    const dps = info + "/n:DPS/n:infDPS";
    const number = value(doc, info + "/n:nNFSe");
    const status = value(doc, info + "/n:cStat");
    const processedAt = new Date(value(doc, info + "/n:dhProc"));
    const checks = {
      estrutura: doc.find(info, namespaces).length === 1 && doc.find(dps, namespaces).length === 1,
      chave: accessKey.slice(9, 23) === cnpj && value(doc, info + "/@Id") === "NFS" + accessKey,
      emitente: value(doc, info + "/n:emit/n:CNPJ") === cnpj,
      prestador: value(doc, dps + "/n:prest/n:CNPJ") === cnpj,
      tpAmb: value(doc, dps + "/n:tpAmb") === "1",
      nNFSe: /^[1-9][0-9]{0,12}$/.test(number),
      cStat: /^(100|102|103|107)$/.test(status),
      dhProc: Number.isFinite(processedAt.getTime()),
    };
    const camposDivergentes = Object.keys(checks).filter((field) => !checks[field as keyof typeof checks]);
    if (camposDivergentes.length) {
      throw new FiscalError("response-mismatch", "O XML diverge da NFS-e, do prestador ou do ambiente consultado.",
        { etapa: "identificar-nfse", camposDivergentes });
    }
    return { number, status, processedAt: processedAt.toISOString() };
  } finally {
    doc.dispose();
  }
}

export function readAuthorizedNfsePrint(xml: Buffer, accessKey: string, cnpj: string) {
  const summary = readProductionNfse(xml, accessKey, cnpj);
  const { doc } = parseXml(xml);
  try {
    const info = "/n:NFSe/n:infNFSe";
    const dps = info + "/n:DPS/n:infDPS";
    const note = (path: string) => value(doc, info + "/n:" + path.split("/").join("/n:"));
    const input = (path: string) => note("DPS/infDPS/" + path);
    const invoices = (path: string) => note("valores/" + path);
    const taxes = (path: string) => input("valores/trib/" + path);
    const reform = (path: string) => note("IBSCBS/" + path);
    const { id } = readDpsInfo(doc, dps, "PRODUCTION");
    const person = (path: string, addressTag: string) => {
      const field = (name: string) => note(path + "/" + name);
      const address = (name: string) => field(addressTag + "/" + name);
      return {
        name: field("xNome"), document: field("CNPJ") || field("CPF") || field("NIF"),
        registration: field("IM"), phone: field("fone"), email: field("email"),
        address: ["xLgr", "nro", "xCpl", "xBairro"].map(address).filter(Boolean).join(", "),
        city: address("cMun") || address("endNac/cMun") || address("endExt/xCidade"),
        uf: address("UF") || address("endExt/xEstProvReg"),
        postalCode: address("CEP") || address("endNac/CEP") || address("endExt/cEndPost"),
        country: address("endExt/cPais"),
      };
    };
    const service = {
      nationalCode: input("serv/cServ/cTribNac"), municipalCode: input("serv/cServ/cTribMun"),
      nationalLabel: note("xTribNac"), municipalLabel: note("xTribMun"), nbs: input("serv/cServ/cNBS"),
      city: note("xLocPrestacao"), country: input("serv/locPrest/cPaisPrestacao"),
      description: input("serv/cServ/xDescServ"), amount: input("valores/vServPrest/vServ"),
    };
    const total = invoices("vLiq");
    if (!service.description || !service.nationalCode || !/^\d+(?:\.\d{1,2})?$/.test(service.amount) ||
        !/^\d+(?:\.\d{1,2})?$/.test(total)) {
      throw new FiscalError("invalid-nfse-print", "O XML autorizado não contém os dados necessários para o DANFSe.");
    }
    const totals = (prefix: "v" | "p") => ["Fed", "Est", "Mun"].map((level) =>
      taxes(`totTrib/${prefix}TotTrib/${prefix}TotTrib${level}`));
    return {
      ...summary, accessKey, id, issuedAt: input("dhEmi"), competence: input("dCompet"),
      dpsNumber: input("nDPS"), series: input("serie"), city: note("xLocEmi"), generator: note("ambGer"),
      purpose: input("IBSCBS/finNFSe") || input("finNFSe"), emitType: input("tpEmit"),
      issuer: person("emit", "enderNac"), buyer: person("DPS/infDPS/toma", "end"),
      intermediary: person("DPS/infDPS/interm", "end"), recipient: person("DPS/infDPS/IBSCBS/dest", "end"),
      recipientIsBuyer: input("IBSCBS/indDest") === "0",
      regime: input("prest/regTrib/opSimpNac"), regimeAssessment: input("prest/regTrib/regApTribSN"),
      service, total,
      discounts: {
        unconditional: input("valores/vDescCondIncond/vDescIncond"), conditional: input("valores/vDescCondIncond/vDescCond"),
      },
      municipal: {
        tax: taxes("tribMun/tribISSQN"), retention: taxes("tribMun/tpRetISSQN"), city: note("xLocIncid"),
        base: invoices("vBC"), rate: invoices("pAliqAplic"), amount: invoices("vISSQN"), totalRetained: invoices("vTotalRet"),
      },
      federal: {
        income: taxes("tribFed/vRetIRRF"), socialSecurity: taxes("tribFed/vRetCP"), socialContributions: taxes("tribFed/vRetCSLL"),
        pis: taxes("tribFed/piscofins/vPis"), cofins: taxes("tribFed/piscofins/vCofins"),
        contributionRetention: taxes("tribFed/piscofins/tpRetPisCofins"),
      },
      reform: {
        classification: input("IBSCBS/valores/trib/gIBSCBS/CST"), category: input("IBSCBS/valores/trib/gIBSCBS/cClassTrib"),
        indicator: input("IBSCBS/cIndOp"), cityCode: reform("cLocalidadeIncid"), city: reform("xLocalidadeIncid"),
        base: reform("valores/vBC"), deduction: reform("valores/vCalcAjusteBCIBSCBS") || reform("valores/vCalcReeRepRes"),
        rateState: reform("valores/uf/pIBSUF"), reducedState: reform("valores/uf/pRedAliqUF"),
        effectiveState: reform("valores/uf/pAliqEfetUF"), state: reform("totCIBS/gIBS/gIBSUFTot/vIBSUF"),
        rateCity: reform("valores/mun/pIBSMun"), reducedCity: reform("valores/mun/pRedAliqMun"),
        effectiveCity: reform("valores/mun/pAliqEfetMun"), municipal: reform("totCIBS/gIBS/gIBSMunTot/vIBSMun"),
        ibs: reform("totCIBS/gIBS/vIBSTot"),
        rateFederal: reform("valores/fed/pCBS"), reducedFederal: reform("valores/fed/pRedAliqCBS"),
        effectiveFederal: reform("valores/fed/pAliqEfetCBS"), cbs: reform("totCIBS/gCBS/vCBS"),
        total: reform("totCIBS/vTotNF"),
      },
      approximateTaxes: { money: totals("v"), percent: totals("p"), simples: taxes("totTrib/pTotTribSN") },
      additionalInfo: [input("serv/infoCompl/xInfComp"), note("xOutInf")].filter(Boolean),
    };
  } finally {
    doc.dispose();
  }
}

export function validateProductionReturnedNfse(xml: Buffer, accessKey: string, cnpj: string, expectedDps: string) {
  const summary = readProductionNfse(xml, accessKey, cnpj);
  const { doc, text } = parseXml(xml);
  try {
    const base = "/n:NFSe/n:infNFSe/n:DPS/n:infDPS";
    const { id } = readDpsInfo(doc, base, "PRODUCTION");
    const isMei = value(doc, base + "/n:prest/n:regTrib/n:opSimpNac") === "2";
    if (id !== expectedDps || (summary.status !== "100" && !(summary.status === "107" && isMei))) {
      throw new FiscalError("response-mismatch", "O XML de produção não confirma a DPS transmitida.",
        { etapa: "confirmar-dps", statusNfse: summary.status, dpsCorrespondente: id === expectedDps });
    }
    verifyRetrievedNoteSignature(doc, text, accessKey);
    return { dpsId: id, accessKey, xml, processedAt: summary.processedAt };
  } finally {
    doc.dispose();
  }
}
