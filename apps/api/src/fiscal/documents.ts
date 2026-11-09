import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { ParseOption, XmlBufferInputProvider, XmlDocument, XmlElement, XsdValidator, xmlRegisterInputProvider } from "libxml2-wasm";
import { SignedXml } from "xml-crypto";
import { inspectCertificate, type loadHomologationSigningKey } from "./certificate.ts";
import { FiscalError, maxXmlBytes } from "./errors.ts";

const namespaces = { n: "http://www.sped.fazenda.gov.br/nfse", ds: "http://www.w3.org/2000/09/xmldsig#" };
const xsdUrl = "https://fiscalflow.invalid/sefin-20261020/";
const schemaNames = ["DPS_v1.01.xsd", "NFSe_v1.01.xsd", "tiposComplexos_v1.01.xsd", "tiposSimples_v1.01.xsd", "xmldsig-core-schema.xsd"] as const;
type Schema = typeof schemaNames[0 | 1];
const schemaDirectory = new URL("../../fiscal-schemas/sefin-20261020/", import.meta.url);
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
    const buffers = Object.fromEntries(schemaNames.map((name) => [xsdUrl + name, readFileSync(new URL(name, schemaDirectory))]));
    if (!xmlRegisterInputProvider(new XmlBufferInputProvider(buffers))) throw new Error();
    schemas = buffers;
    return buffers;
  } catch {
    throw new FiscalError("schema-unavailable", "O pacote oficial de esquemas da homologação está indisponível.");
  }
}

function validateSchema(doc: XmlDocument, schema: Schema) {
  const source = loadSchemas()[xsdUrl + schema];
  const xsd = XmlDocument.fromBuffer(source, { url: xsdUrl + schema });
  try {
    const validator = XsdValidator.fromDoc(xsd);
    try {
      validator.validate(doc);
    } catch {
      throw new FiscalError("invalid-schema", "O XML não atende ao esquema oficial de homologação de 20/10/2026.");
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

function readDpsInfo(doc: XmlDocument, base: string) {
  if (value(doc, `${base}/n:tpAmb`) !== "2") {
    throw new FiscalError("environment-not-allowed", "A DPS deve indicar homologação com tpAmb igual a 2.");
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

export function signHomologationDps(unsigned: Buffer, key: ReturnType<typeof loadHomologationSigningKey>) {
  const { text, doc } = parseXml(unsigned);
  try {
    validateSchema(doc, "DPS_v1.01.xsd");
    if (value(doc, "/n:DPS/@versao") !== "1.01") {
      throw new FiscalError("unsupported-layout", "Use o leiaute de homologação versão 1.01.");
    }
    const { cnpj } = readDpsInfo(doc, "/n:DPS/n:infDPS");
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
  const { id } = validateDps(xml);
  return { id, xml };
}

export function validateDps(xml: Buffer) {
  const { text, doc } = parseXml(xml);
  try {
    if (xml[0] !== 0x3c || !/^<\?xml\s+version\s*=\s*(["'])1\.0\1\s+encoding\s*=\s*(["'])UTF-8\2/i.test(text)) {
      throw new FiscalError("missing-xml-declaration", "A DPS deve começar com a declaração XML 1.0 em UTF-8. Gere o XML novamente.");
    }
    validateSchema(doc, "DPS_v1.01.xsd");
    const base = "/n:DPS/n:infDPS";
    if (value(doc, "/n:DPS/@versao") !== "1.01") {
      throw new FiscalError("unsupported-layout", "Use o leiaute de homologação versão 1.01.");
    }
    const info = readDpsInfo(doc, base);
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
      const actual = readDpsInfo(signed, "/n:infDPS");
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

export function readLocalDpsSummary(xml: Buffer) {
  const { doc } = parseXml(xml);
  const base = "/n:DPS/n:infDPS";
  try {
    const { id, cnpj } = readDpsInfo(doc, base);
    return {
      id, cnpj,
      series: value(doc, base + "/n:serie"),
      number: value(doc, base + "/n:nDPS"),
      competence: value(doc, base + "/n:dCompet"),
      customerName: value(doc, base + "/n:toma/n:xNome"),
      customerDocument: value(doc, base + "/n:toma/n:CNPJ | " + base + "/n:toma/n:CPF"),
      serviceCode: value(doc, base + "/n:serv/n:cServ/n:cTribNac"),
      description: value(doc, base + "/n:serv/n:cServ/n:xDescServ"),
      amount: value(doc, base + "/n:valores/n:vServPrest/n:vServ"),
    };
  } finally {
    doc.dispose();
  }
}

export function validateReturnedNfse(xml: Buffer, accessKey: string, expectedDps?: string) {
  const { doc } = parseXml(xml);
  try {
    validateSchema(doc, "NFSe_v1.01.xsd");
    const info = "/n:NFSe/n:infNFSe";
    const dps = `${info}/n:DPS/n:infDPS`;
    const dpsId = value(doc, `${dps}/@Id`);
    if (value(doc, `${info}/@Id`) !== `NFS${accessKey}` ||
        value(doc, `${dps}/n:tpAmb`) !== "2" ||
        !dpsIdPattern.test(dpsId) ||
        (expectedDps !== undefined && expectedDps !== dpsId)) {
      throw new FiscalError("response-mismatch", "O XML retornado diverge da chave, da DPS ou do ambiente consultado.");
    }
    return { dpsId, accessKey, xml };
  } finally {
    doc.dispose();
  }
}
