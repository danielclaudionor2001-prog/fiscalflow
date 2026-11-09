import { createPrivateKey, randomBytes, X509Certificate } from "node:crypto";
import { createSecureContext, type SecureContext } from "node:tls";
import forge from "node-forge";
import { FiscalError, maxPfxBytes } from "./errors.ts";

const cnpjOid = "2.16.76.1.3.3";
const clientAuthOid = "1.3.6.1.5.5.7.3.2";
const cnpjPattern = /^[0-9A-Z]{12}[0-9]{2}$/;

export type CertificateIdentity = { cnpj: string; fingerprint: string };
export type HomologationCredential = CertificateIdentity & { secureContext: SecureContext };

function invalidCertificate() {
  return new FiscalError("invalid-certificate", "Use um certificado A1 e-CNPJ válido, com a chave privada protegida e a finalidade apropriada.");
}

function items(node: forge.asn1.Asn1 | undefined) {
  return Array.isArray(node?.value) ? node.value : [];
}

function readCnpj(certificate: forge.pki.Certificate) {
  const san = certificate.getExtension("subjectAltName");
  if (!san || !("value" in san) || typeof san.value !== "string") throw invalidCertificate();
  const otherNames = items(forge.asn1.fromDer(san.value, true));
  const holders: string[] = [];
  for (const otherName of otherNames) {
    if (otherName.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC || otherName.type !== 0) continue;
    const [oid, value] = items(otherName);
    if (oid?.type !== forge.asn1.Type.OID || typeof oid.value !== "string" || forge.asn1.derToOid(oid.value) !== cnpjOid) continue;
    const [holder] = items(value);
    if (typeof holder?.value !== "string" || !cnpjPattern.test(holder.value)) throw invalidCertificate();
    holders.push(holder.value);
  }
  if (holders.length !== 1) throw invalidCertificate();
  return holders[0];
}

export function inspectCertificate(cert: X509Certificate, usage: "signature" | "client"): CertificateIdentity {
  try {
    const now = Date.now();
    const from = Date.parse(cert.validFrom);
    const until = Date.parse(cert.validTo);
    if (cert.ca || cert.publicKey.asymmetricKeyType !== "rsa" || !(from <= now && now < until)) throw invalidCertificate();

    const parsed = forge.pki.certificateFromAsn1(forge.asn1.fromDer(cert.raw.toString("binary"), true));
    if (parsed.version !== 2) throw invalidCertificate();
    if (usage === "client" && !cert.keyUsage?.includes(clientAuthOid)) throw invalidCertificate();
    if (usage === "signature") {
      const keyUsage = parsed.getExtension("keyUsage");
      if (!keyUsage || !("digitalSignature" in keyUsage) || !("nonRepudiation" in keyUsage) ||
          keyUsage.digitalSignature !== true || keyUsage.nonRepudiation !== true) throw invalidCertificate();
    }
    return { cnpj: readCnpj(parsed), fingerprint: cert.fingerprint256 };
  } catch {
    throw invalidCertificate();
  }
}

function loadProtectedKey(pfx: Buffer, passphrase: string) {
  if (pfx.length === 0 || pfx.length > maxPfxBytes || !passphrase) throw invalidCertificate();
  try {
    const asn1 = forge.asn1.fromDer(pfx.toString("binary"), true);
    if (items(asn1).length !== 3) throw invalidCertificate(); // Require the PKCS#12 MAC.
    const bundle = forge.pkcs12.pkcs12FromAsn1(asn1, true, passphrase);
    const { pkcs8ShroudedKeyBag, keyBag, certBag } = forge.pki.oids;
    const protectedKeys = bundle.getBags({ bagType: pkcs8ShroudedKeyBag })[pkcs8ShroudedKeyBag] ?? [];
    const unprotectedKeys = bundle.getBags({ bagType: keyBag })[keyBag] ?? [];
    const certificateBags = bundle.getBags({ bagType: certBag })[certBag] ?? [];
    const bundleKey = protectedKeys[0]?.key;
    if (protectedKeys.length !== 1 || unprotectedKeys.length || !bundleKey) throw invalidCertificate();

    const privateKey = createPrivateKey(forge.pki.privateKeyToPem(bundleKey));
    const certificates = certificateBags.flatMap(({ cert }) => cert ? [cert] : []);
    const matching = certificates.map((source) => ({
      source,
      certificate: new X509Certificate(forge.pki.certificateToPem(source)),
    })).filter(({ certificate }) => certificate.checkPrivateKey(privateKey));
    if (matching.length !== 1) throw invalidCertificate();

    const [{ source, certificate }] = matching;
    return { privateKey, bundleKey, certificate, chain: [source, ...certificates.filter((cert) => cert !== source)] };
  } catch (error) {
    if (error instanceof Error && error.message === "PKCS#12 MAC could not be verified. Invalid password?") {
      throw new FiscalError("pfx-unlock-failed", "Não foi possível desbloquear o arquivo PFX com a senha informada. Confira a senha do certificado A1.");
    }
    throw invalidCertificate();
  }
}

export function loadTrustedA1(
  pfx: Buffer,
  passphrase: string,
  trustedRoots: string[],
  expectedCnpj: string,
  intermediates: string[] = [],
) {
  const { privateKey, certificate, chain } = loadProtectedKey(pfx, passphrase);
  inspectCertificate(certificate, "client");
  const identity = inspectCertificate(certificate, "signature");
  if (identity.cnpj !== expectedCnpj) {
    throw new FiscalError("certificate-holder-mismatch", "O CNPJ do A1 diverge da empresa.");
  }

  const policy = chain[0].getExtension("certificatePolicies");
  const policies = policy && "id" in policy && policy.id === "2.5.29.32" && "value" in policy && typeof policy.value === "string"
    ? items(forge.asn1.fromDer(policy.value, true)) : [];
  if (!policies.some((entry) => {
    const [oid] = items(entry);
    return oid?.type === forge.asn1.Type.OID && typeof oid.value === "string" &&
      /^2\.16\.76\.1\.2\.1\.[0-9]+$/.test(forge.asn1.derToOid(oid.value));
  })) throw invalidCertificate();

  try {
    const store = forge.pki.createCaStore(trustedRoots);
    const candidates = [
      ...chain.slice(1),
      ...[...intermediates, ...trustedRoots].map((pem) => forge.pki.certificateFromPem(pem)),
    ];
    const path = [chain[0]];
    while (!store.hasCertificate(path[path.length - 1]) && path.length < 10) {
      const child = path[path.length - 1];
      const parent = candidates.find((candidate) => {
        if (path.includes(candidate) || !child.isIssuer(candidate)) return false;
        try { return candidate.verify(child); } catch { return false; }
      });
      if (!parent) break;
      path.push(parent);
    }
    if (!store.hasCertificate(path[path.length - 1])) throw invalidCertificate();
    forge.pki.verifyCertificateChain(store, path);
  } catch {
    throw new FiscalError("certificate-chain-untrusted", "A cadeia do certificado não pôde ser validada.");
  }

  return {
    ...identity, privateKey, publicCert: certificate.toString(),
    validFrom: new Date(certificate.validFrom), validUntil: new Date(certificate.validTo),
  };
}

export function loadHomologationCredential(pfx: Buffer, passphrase: string): HomologationCredential {
  const { bundleKey, certificate, chain } = loadProtectedKey(pfx, passphrase);
  const identity = inspectCertificate(certificate, "client");
  try {
    // Normalize legacy PFX encryption without changing the certificate or enabling legacy TLS algorithms.
    const localPassphrase = randomBytes(32).toString("base64url");
    const encoded = forge.pkcs12.toPkcs12Asn1(bundleKey, chain, localPassphrase, { algorithm: "aes256" });
    const compatiblePfx = Buffer.from(forge.asn1.toDer(encoded).getBytes(), "binary");
    try {
      const secureContext = createSecureContext({ pfx: compatiblePfx, passphrase: localPassphrase, minVersion: "TLSv1.2" });
      return { ...identity, secureContext };
    } finally {
      compatiblePfx.fill(0);
    }
  } catch {
    throw new FiscalError("certificate-tls", "O A1 foi lido, mas não foi possível preparar o certificado e a cadeia para a conexão TLS.");
  }
}

export function loadHomologationSigningKey(pfx: Buffer, passphrase: string) {
  const { privateKey, certificate } = loadProtectedKey(pfx, passphrase);
  inspectCertificate(certificate, "client");
  return { ...inspectCertificate(certificate, "signature"), privateKey, publicCert: certificate.toString() };
}
