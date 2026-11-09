import forge from "node-forge";

const { pki, asn1 } = forge;
const { UNIVERSAL, CONTEXT_SPECIFIC } = asn1.Class;
const { SEQUENCE, OID, OCTETSTRING } = asn1.Type;
const seq = (children: forge.asn1.Asn1[]) => asn1.create(UNIVERSAL, SEQUENCE, true, children);
const oid = (value: string) => asn1.create(UNIVERSAL, OID, false, asn1.oidToDer(value).getBytes());
const der = (value: forge.asn1.Asn1) => asn1.toDer(value).getBytes();

function certificate(publicKey: forge.pki.rsa.PublicKey, serial: string, commonName: string) {
  const cert = pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = serial;
  cert.validity.notBefore = new Date(Date.now() - 3600_000);
  cert.validity.notAfter = new Date(Date.now() + 86400_000);
  cert.setSubject([{ name: "commonName", value: commonName }]);
  return cert;
}

export function testAuthority(withIntermediate = false) {
  const caKeys = pki.rsa.generateKeyPair(2048);
  const ca = certificate(caKeys.publicKey, "01", "Raiz de teste FiscalFlow");
  ca.setIssuer(ca.subject.attributes);
  ca.setExtensions([{ name: "basicConstraints", cA: true, critical: true }, { name: "keyUsage", keyCertSign: true }]);
  ca.sign(caKeys.privateKey, forge.md.sha256.create());
  const issuerKeys = withIntermediate ? pki.rsa.generateKeyPair(2048) : caKeys;
  const issuer = withIntermediate ? certificate(issuerKeys.publicKey, "03", "Intermediária de teste FiscalFlow") : ca;
  if (withIntermediate) {
    issuer.setIssuer(ca.subject.attributes);
    issuer.setExtensions([{ name: "basicConstraints", cA: true, critical: true }, { name: "keyUsage", keyCertSign: true }]);
    issuer.sign(caKeys.privateKey, forge.md.sha256.create());
  }
  return {
    root: pki.certificateToPem(ca),
    intermediate: withIntermediate ? pki.certificateToPem(issuer) : undefined,
    issue(cnpj: string, options: { expired?: boolean; policy?: string; leafOnly?: boolean } = {}) {
      const keys = pki.rsa.generateKeyPair(2048);
      const leaf = certificate(keys.publicKey, "02", "Empresa fictícia FiscalFlow");
      leaf.setIssuer(issuer.subject.attributes);
      if (options.expired) leaf.validity.notAfter = new Date(Date.now() - 1000);
      const otherName = asn1.create(CONTEXT_SPECIFIC, 0, true, [
        oid("2.16.76.1.3.3"),
        asn1.create(CONTEXT_SPECIFIC, 0, true, [asn1.create(UNIVERSAL, OCTETSTRING, false, cnpj)]),
      ]);
      leaf.setExtensions([
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, nonRepudiation: true },
        { name: "extKeyUsage", clientAuth: true },
        { id: "2.5.29.17", value: der(seq([otherName])) },
        { id: "2.5.29.32", value: der(seq([seq([oid(options.policy ?? "2.16.76.1.2.1.1")])])) },
      ]);
      leaf.sign(issuerKeys.privateKey, forge.md.sha256.create());
      const password = "somente-certificado-sintetico";
      const chain = options.leafOnly ? [leaf] : withIntermediate ? [leaf, issuer, ca] : [leaf, ca];
      const pfx = Buffer.from(der(forge.pkcs12.toPkcs12Asn1(keys.privateKey, chain, password, { algorithm: "aes256" })), "binary");
      return { pfx, password };
    },
  };
}
