import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import forge from "node-forge";
import { SignedXml } from "xml-crypto";
import { inspectCertificate, loadHomologationCredential, loadHomologationSigningKey } from "../src/fiscal/certificate.ts";
import { assertPreparedDpsMatchesNote, signHomologationDps, validateDps, validateReturnedNfse } from "../src/fiscal/documents.ts";
import { createUnsignedDps, readDpsDraft } from "../src/fiscal/dps-draft.ts";
import { fileLedger } from "../src/fiscal/ledger.ts";
import { createSefinHomologation, summarizeSefinProductionNote } from "../src/fiscal/sefin.ts";
import { sefinHomologationEndpoint, sefinProductionEndpoint, sefinTransport, type SefinTransport } from "../src/fiscal/sefin-transport.ts";

// All documents and the certificate in these tests are generated locally.
const cnpj = "00000000000000";
const city = "3550308";
const id = `DPS${city}2${cnpj}00001000000000000001`;
const accessKey = `${city}22${cnpj}${"0".repeat(26)}1`;
const namespace = "http://www.sped.fazenda.gov.br/nfse";
const timestamp = "2026-10-21T12:00:00-03:00";
const envelope = { tipoAmbiente: 2, versaoAplicativo: "Fixture local", dataHoraProcessamento: timestamp };
const notFound = { status: 404, body: { ...envelope, erro: { codigo: "E999" } } };

function testCertificate() {
  const { asn1, pki } = forge;
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 60000);
  cert.validity.notAfter = new Date(Date.now() + 3600000);
  const name = [{ name: "commonName", value: "Fixture FiscalFlow" }];
  cert.setSubject(name);
  cert.setIssuer(name);
  const otherName = asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer("2.16.76.1.3.3").getBytes()),
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, cnpj)]),
  ]);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, nonRepudiation: true },
    { name: "extKeyUsage", clientAuth: true },
    { id: "2.5.29.17", value: asn1.toDer(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [otherName])).getBytes() },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const passphrase = "ephemeral-fixture-password";
  const pfx = Buffer.from(asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, cert, passphrase, { algorithm: "aes256" })).getBytes(), "binary");
  return { pem: pki.certificateToPem(cert), privateKey: pki.privateKeyToPem(keys.privateKey), pfx, passphrase };
}

const certificate = testCertificate();
const identity = inspectCertificate(new X509Certificate(certificate.pem), "client");

function sign(xml: string, tag: string) {
  const canonicalization = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
  const signer = new SignedXml({
    privateKey: certificate.privateKey,
    publicCert: certificate.pem,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: canonicalization,
  });
  signer.addReference({
    xpath: `//*[local-name(.)='${tag}']`,
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", canonicalization],
  });
  signer.computeSignature(xml, { location: { reference: "/*", action: "append" } });
  return signer.getSignedXml();
}

const unsignedDps = `<DPS xmlns="${namespace}" versao="1.01"><infDPS Id="${id}">` +
  `<tpAmb>2</tpAmb><dhEmi>${timestamp}</dhEmi><verAplic>FiscalFlow-Teste</verAplic>` +
  "<serie>1</serie><nDPS>1</nDPS><dCompet>2026-10-21</dCompet><tpEmit>1</tpEmit><finNFSe>0</finNFSe>" +
  `<cLocEmi>${city}</cLocEmi><prest><CNPJ>${cnpj}</CNPJ><regTrib><opSimpNac>1</opSimpNac><regEspTrib>0</regEspTrib></regTrib></prest>` +
  `<serv><locPrest><cLocPrestacao>${city}</cLocPrestacao></locPrest><cServ><cTribNac>010101</cTribNac><xDescServ>Fixture local</xDescServ></cServ></serv>` +
  "<valores><vServPrest><vServ>1.00</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun>" +
  "<totTrib><indTotTrib>0</indTotTrib></totTrib></trib></valores></infDPS></DPS>";
const signedDps = sign(unsignedDps, "infDPS");
const xmlDeclaration = '<?xml version="1.0" encoding="UTF-8"?>';
const dpsDocument = (xml: string) => Buffer.from(xmlDeclaration + xml, "utf8");
const document = dpsDocument(signedDps);
const unsignedNote = `<NFSe xmlns="${namespace}" versao="1.01"><infNFSe Id="NFS${accessKey}">` +
  "<xLocEmi>São Paulo</xLocEmi><xLocPrestacao>São Paulo</xLocPrestacao><nNFSe>1</nNFSe>" +
  "<xTribNac>Fixture local</xTribNac><verAplic>FiscalFlow-Teste</verAplic><ambGer>2</ambGer><tpEmis>1</tpEmis>" +
  `<cStat>100</cStat><dhProc>${timestamp}</dhProc><nDFSe>1</nDFSe><emit><CNPJ>${cnpj}</CNPJ><xNome>Empresa fictícia</xNome>` +
  `<enderNac><xLgr>Rua de teste</xLgr><nro>1</nro><xBairro>Bairro de teste</xBairro><cMun>${city}</cMun><UF>SP</UF><CEP>01000000</CEP></enderNac></emit>` +
  `<valores><vLiq>1.00</vLiq></valores>${signedDps}</infNFSe></NFSe>`;
const note = Buffer.from(sign(unsignedNote, "infNFSe"));
const notePayload = { ...envelope, chaveAcesso: accessKey, nfseXmlGZipB64: gzipSync(note).toString("base64") };
const found = { status: 200, body: { ...envelope, idDps: id, chaveAcesso: accessKey } };
const authorized = { status: 201, body: { ...notePayload, idDps: id } };

async function journal(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "fiscalflow-nfse-"));
  t.after(async () => {
    for (const name of await readdir(directory)) await unlink(join(directory, name));
    await rmdir(directory);
  });
  return { directory, ledger: fileLedger(directory) };
}

function transport(request: SefinTransport["request"]): SefinTransport {
  return { identity, request };
}

test("DPS validation uses the official schemas, signature and production-restricted environment", () => {
  assert.deepEqual(validateDps(document), { id, ...identity });
  assert.throws(() => validateDps(Buffer.from(signedDps)), { code: "missing-xml-declaration" });
  assert.throws(() => validateDps(dpsDocument(unsignedDps)), { code: "invalid-signature" });
  assert.throws(() => validateDps(dpsDocument(signedDps.replace("Fixture local", "Modificado"))), { code: "invalid-signature" });
  assert.throws(() => validateDps(dpsDocument(sign(unsignedDps.replace("<tpAmb>2", "<tpAmb>1"), "infDPS"))), { code: "environment-not-allowed" });
  assert.throws(() => validateDps(dpsDocument(signedDps.replace("<finNFSe>0</finNFSe>", ""))), { code: "invalid-schema" });
  assert.throws(() => validateDps(dpsDocument(signedDps.replace("<serie>1", "<serie>2"))), { code: "invalid-dps-id" });
  assert.throws(() => validateDps(Buffer.from('<!DOCTYPE DPS SYSTEM "file:///secret">' + signedDps)), { code: "invalid-xml" });
});

test("CLI validates a signed fixture locally without reading a credential", async (t) => {
  const { directory } = await journal(t);
  const file = join(directory, "fixture.xml");
  await writeFile(file, document);
  const cli = fileURLToPath(new URL("../src/fiscal/cli.ts", import.meta.url));
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli, "validar", "--arquivo", file]);
  assert.deepEqual(JSON.parse(stdout), { state: "locally-validated", idDps: id });
  assert.equal(stderr, "");
});

test("CLI reports an invalid invocation without reading the certificate", async () => {
  const cli = fileURLToPath(new URL("../src/fiscal/cli.ts", import.meta.url));
  const run = promisify(execFile);
  const args = ["gerar", "--dados", "dados.json", "--pfx", "--saida", "DPS.xml", "Get-Item", "-LiteralPath", "DPS.xml"];
  await assert.rejects(run(process.execPath, [cli, ...args]), (error: Error & { stderr?: string }) => {
    const result = JSON.parse(error.stderr ?? "{}");
    assert.equal(result.code, "invalid-arguments");
    assert.match(result.message, /--pfx/);
    return true;
  });
});

const draftData = {
  cnpjPrestador: cnpj,
  cLocEmi: city,
  serie: "1",
  nDPS: "1",
  dCompet: "2026-10-21",
  opSimpNac: "3",
  regApTribSN: "1",
  regEspTrib: "0",
  cLocPrestacao: city,
  cTribNac: "010101",
  xDescServ: "Análise & teste <local>",
  vServ: "1.00",
  tpRetISSQN: "1",
  totTrib: { pTotTribSN: "6.00" },
};

test("DPS generation binds the signed data to the restricted environment and certificate holder", () => {
  const key = loadHomologationSigningKey(certificate.pfx, certificate.passphrase);
  const draft = readDpsDraft(Buffer.from(JSON.stringify(draftData)));
  const unsigned = createUnsignedDps(draft, new Date("2026-10-22T02:42:05Z"));
  const signed = signHomologationDps(unsigned, key);
  assert.equal(signed.id, id);
  assert.deepEqual(validateDps(signed.xml), { id, ...identity });
  assert.match(signed.xml.toString(), /<dhEmi>2026-10-21T23:42:05-03:00<\/dhEmi>/);
  assert.match(signed.xml.toString(), /Análise &amp; teste &lt;local&gt;/);
  assert.match(signed.xml.toString(), /rsa-sha1/);
  assert.throws(() => signHomologationDps(createUnsignedDps({ ...draft, cnpjPrestador: "00000000000001" }), key),
    { code: "certificate-holder-mismatch" });
  assert.throws(() => signHomologationDps(Buffer.from(unsigned.toString().replace("<tpAmb>2", "<tpAmb>1")), key),
    { code: "environment-not-allowed" });
  assert.throws(() => readDpsDraft(Buffer.from(JSON.stringify({ ...draftData, tpAmb: "1" }))), { code: "invalid-dps-data" });
});

test("CLI creates a template and a locally signed XML with no overwrite", async (t) => {
  const { directory } = await journal(t);
  const input = join(directory, "dados de teste.json");
  const pfx = join(directory, "certificado de teste.pfx");
  const output = join(directory, "DPS assinada.xml");
  const cli = fileURLToPath(new URL("../src/fiscal/cli.ts", import.meta.url));
  const run = promisify(execFile);
  const template = await run(process.execPath, [cli, "modelo", "--saida", input]);
  assert.deepEqual(JSON.parse(template.stdout), { state: "template-created" });
  assert.throws(() => readDpsDraft(Buffer.from("{}")), { code: "invalid-dps-data" });
  await writeFile(input, JSON.stringify(draftData));
  await writeFile(pfx, certificate.pfx);

  const generate = () => {
    const child = run(process.execPath, [cli, "gerar", "--dados", input, "--pfx", pfx, "--saida", output]);
    child.child.stdin!.end(certificate.passphrase + "\n");
    return child;
  };
  const { stdout, stderr } = await generate();
  assert.deepEqual(JSON.parse(stdout), { state: "locally-signed", idDps: id, arquivo: output });
  assert.equal(stderr, "");
  const saved = await readFile(output);
  assert.ok(saved.subarray(0, xmlDeclaration.length).equals(Buffer.from(xmlDeclaration)));
  assert.deepEqual(validateDps(saved), { id, ...identity });
  await assert.rejects(generate(), (error: Error & { stderr?: string }) =>
    JSON.parse(error.stderr ?? "{}").code === "output-file");
  assert.deepEqual(await readFile(output), saved);
});

test("PKCS#12 checks the password, private key and e-CNPJ; transport is restricted to homologation", async () => {
  const credential = loadHomologationCredential(certificate.pfx, certificate.passphrase);
  assert.equal(credential.cnpj, cnpj);
  assert.equal(credential.fingerprint, identity.fingerprint);
  assert.throws(() => loadHomologationCredential(certificate.pfx, "incorrect"), { code: "pfx-unlock-failed" });
  assert.equal(sefinHomologationEndpoint, "https://sefin.producaorestrita.nfse.gov.br/SefinNacional");
  await assert.rejects(sefinTransport(credential).request("POST", "/nfse/eventos"), { code: "invalid-operation" });
});

function legacyCertificateBundle(pfx: Buffer, passphrase: string) {
  const { asn1, pki, pkcs12 } = forge;
  const universal = asn1.Class.UNIVERSAL;
  const context = asn1.Class.CONTEXT_SPECIFIC;
  const sequence = (value: forge.asn1.Asn1[]) => asn1.create(universal, asn1.Type.SEQUENCE, true, value);
  const oid = (value: string) => asn1.create(universal, asn1.Type.OID, false, asn1.oidToDer(value).getBytes());
  const octets = (value: string) => asn1.create(universal, asn1.Type.OCTETSTRING, false, value);
  const integer = (value: number) => asn1.create(universal, asn1.Type.INTEGER, false, asn1.integerToDer(value).getBytes());
  const children = (node: forge.asn1.Asn1) => node.value as forge.asn1.Asn1[];

  const bundle = asn1.fromDer(pfx.toString("binary"));
  const [, contents, macData] = children(bundle);
  const [safeBytes] = children(children(contents)[1]);
  const safe = asn1.fromDer(safeBytes.value as string);
  const [certs] = children(safe);
  const [certBytes] = children(children(certs)[1]);

  // Encrypt the certificate safe with the legacy RC2-40 PBE used by existing A1 exports.
  const salt = forge.util.createBuffer(forge.random.getBytesSync(8));
  const iterations = 2048;
  const key = pkcs12.generateKey(passphrase, salt, 1, iterations, 5);
  const iv = pkcs12.generateKey(passphrase, salt, 2, iterations, 8);
  const cipher = forge.rc2.createEncryptionCipher(key, 40);
  cipher.start(iv);
  cipher.update(forge.util.createBuffer(certBytes.value as string));
  assert.ok(cipher.finish());
  const algorithm = sequence([oid(pki.oids["pbewithSHAAnd40BitRC2-CBC"]), sequence([octets(salt.bytes()), integer(iterations)])]);
  const encryptedContents = sequence([oid(pki.oids.data), algorithm, asn1.create(context, 0, false, cipher.output.getBytes())]);
  children(safe)[0] = sequence([oid(pki.oids.encryptedData), asn1.create(context, 0, true, [sequence([integer(0), encryptedContents])])]);

  safeBytes.value = asn1.toDer(safe).getBytes();
  const [digest, macSalt, macIterations] = children(macData);
  const count = asn1.derToInteger(macIterations.value as string);
  const macKey = pkcs12.generateKey(passphrase, forge.util.createBuffer(macSalt.value as string), 3, count, 20);
  const mac = forge.hmac.create();
  mac.start("sha1", macKey);
  mac.update(safeBytes.value);
  children(digest)[1].value = mac.digest().getBytes();
  return Buffer.from(asn1.toDer(bundle).getBytes(), "binary");
}

test("legacy RC2-40 A1 exports build a TLS context using the original certificate identity", () => {
  const legacy = legacyCertificateBundle(certificate.pfx, certificate.passphrase);
  assert.equal(loadHomologationSigningKey(legacy, certificate.passphrase).fingerprint, identity.fingerprint);
  const credential = loadHomologationCredential(legacy, certificate.passphrase);
  assert.deepEqual(sefinTransport(credential).identity, identity);
  assert.ok(credential.secureContext);
  assert.throws(() => loadHomologationSigningKey(legacy, "incorrect"), { code: "pfx-unlock-failed" });
});

test("official return schema binds the NFS-e to the access key, DPS and environment", () => {
  assert.deepEqual(validateReturnedNfse(note, accessKey, id), { dpsId: id, accessKey, xml: note });
  assert.throws(() => validateReturnedNfse(note, accessKey.replace(/1$/, "2"), id), { code: "response-mismatch" });
  const production = Buffer.from(note.toString().replace("<tpAmb>2", "<tpAmb>1"));
  assert.throws(() => validateReturnedNfse(production, accessKey, id), { code: "response-mismatch" });
});

test("a matching DPS identifier cannot attach an NFS-e for a different submission", () => {
  assert.doesNotThrow(() => assertPreparedDpsMatchesNote(document, note));
  const other = Buffer.from(note.toString().replace("<xDescServ>Fixture local</xDescServ>", "<xDescServ>Outro serviço</xDescServ>"));
  assert.throws(() => assertPreparedDpsMatchesNote(document, other), { code: "response-mismatch" });
});

test("production lookup confirms only the requested production note from the certificate holder", () => {
  assert.equal(sefinProductionEndpoint, "https://sefin.nfse.gov.br/SefinNacional");
  const xml = note.toString("utf8").replace("<tpAmb>2</tpAmb>", "<tpAmb>1</tpAmb>");
  const productionBody = { ...notePayload, tipoAmbiente: 1, nfseXmlGZipB64: gzipSync(xml).toString("base64") };
  assert.deepEqual(summarizeSefinProductionNote({ status: 200, body: productionBody }, accessKey, cnpj), {
    number: "1", status: "100", processedAt: new Date(timestamp).toISOString(),
  });
  assert.throws(() => summarizeSefinProductionNote({ status: 200, body: notePayload }, accessKey, cnpj), {
    code: "invalid-production-response",
  });
  assert.throws(() => summarizeSefinProductionNote({ status: 200, body: productionBody }, accessKey, "00000000000001"), {
    code: "invalid-production-response",
  });
  assert.throws(() => summarizeSefinProductionNote({ status: 200, body: productionBody }, accessKey.replace(/1$/, "2"), cnpj), {
    code: "invalid-production-response",
  });
  assert.throws(() => summarizeSefinProductionNote({ status: 403, body: {} }, accessKey, cnpj), {
    code: "production-lookup-denied",
  });
});

test("a returned NFS-e can use the earlier official schema revision without weakening DPS validation", () => {
  const earlierDps = sign(unsignedDps.replace("<finNFSe>0</finNFSe>", ""), "infDPS");
  const earlierNote = Buffer.from(sign(unsignedNote.replace(signedDps, earlierDps), "infNFSe"));
  assert.throws(() => validateDps(dpsDocument(earlierDps)), { code: "invalid-schema" });
  assert.deepEqual(validateReturnedNfse(earlierNote, accessKey, id), { dpsId: id, accessKey, xml: earlierNote });
  assert.doesNotThrow(() => assertPreparedDpsMatchesNote(document, earlierNote));
  const invalidNote = Buffer.from(earlierNote.toString("utf8").replace("<nNFSe>1</nNFSe>", "<nNFSe>inválido</nNFSe>"));
  assert.throws(() => validateReturnedNfse(invalidNote, accessKey, id), { code: "invalid-schema" });
});

test("key lookup recovers a signed NFS-e across schema revisions only for the matching test DPS", async (t) => {
  const { ledger } = await journal(t);
  const reordered = signedDps.replace("<finNFSe>0</finNFSe>", "").replace("</cLocEmi>", "</cLocEmi><finNFSe>0</finNFSe>");
  const retrieved = Buffer.from(sign(unsignedNote.replace(signedDps, reordered), "infNFSe"));
  let received = retrieved;
  const provider = createSefinHomologation(transport(async (method, path) => {
    assert.equal(method, "GET");
    assert.equal(path, "/nfse/" + accessKey);
    return { status: 200, body: { ...notePayload, nfseXmlGZipB64: gzipSync(received).toString("base64") } };
  }), ledger);
  assert.throws(() => validateReturnedNfse(retrieved, accessKey, id), { code: "invalid-schema" });
  assert.deepEqual(await provider.getNote(accessKey, id), { dpsId: id, accessKey, xml: retrieved });
  await assert.rejects(provider.getNote(accessKey, id.replace(/1$/, "2")), { code: "response-mismatch" });
  received = Buffer.from(retrieved.toString("utf8").replace("<vLiq>1.00</vLiq>", "<vLiq>9.00</vLiq>"));
  await assert.rejects(provider.getNote(accessKey, id), { code: "invalid-signature" });
});

test("adapter sends exactly one GZip/Base64 DPS and journals the confirmed result", async (t) => {
  const { directory, ledger } = await journal(t);
  const calls: string[] = [];
  const provider = createSefinHomologation(transport(async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (method === "GET") return notFound;
    assert.deepEqual(Object.keys(body!), ["dpsXmlGZipB64"]);
    assert.deepEqual(gunzipSync(Buffer.from(body!.dpsXmlGZipB64, "base64")), document);
    return authorized;
  }), ledger);
  assert.equal((await provider.submit(document)).state, "authorized");
  assert.deepEqual(calls, [`GET /dps/${id}`, "POST /nfse"]);
  const [file] = await readdir(directory);
  const events = (await readFile(join(directory, file), "utf8")).trim().split("\n").map((line) => JSON.parse(line).event);
  assert.deepEqual(events, ["reserved", "authorized"]);
  await assert.rejects(provider.submit(dpsDocument(sign(unsignedDps.replace("Fixture local", "Outro documento"), "infDPS"))), {
    code: "dps-id-reused",
  });
  assert.equal(calls.length, 2);
});

test("timeout is reconciled with lookup and retrieval, without another POST", async (t) => {
  const { ledger } = await journal(t);
  const calls: string[] = [];
  const provider = createSefinHomologation(transport(async (method, path) => {
    calls.push(`${method} ${path}`);
    if (method === "POST") throw new Error("simulated connection failure");
    if (path.startsWith("/nfse/")) return { status: 200, body: notePayload };
    return calls.length === 1 ? notFound : found;
  }), ledger);
  assert.equal((await provider.submit(document)).state, "reconciled");
  assert.deepEqual(calls, [`GET /dps/${id}`, "POST /nfse", `GET /dps/${id}`, `GET /nfse/${accessKey}`]);
});

test("journal prevents concurrent and later POSTs when a result stays uncertain", async (t) => {
  const { directory, ledger } = await journal(t);
  let posts = 0;
  const mock = transport(async (method) => {
    if (method === "GET") return notFound;
    posts++;
    return { status: 500, body: {} };
  });
  const provider = createSefinHomologation(mock, ledger);
  await Promise.allSettled([provider.submit(document), provider.submit(document)]);
  const restarted = createSefinHomologation(mock, fileLedger(directory));
  assert.deepEqual(await restarted.submit(document), { state: "indeterminate", id });
  assert.equal(posts, 1);
});

test("untrusted lookup and mismatched credentials prevent transmission", async (t) => {
  const { ledger } = await journal(t);
  let posts = 0;
  const mock = transport(async (method) => {
    if (method === "POST") posts++;
    return { status: 404, body: { ...envelope, tipoAmbiente: 1, erro: {} } };
  });
  await assert.rejects(createSefinHomologation(mock, ledger).submit(document), { code: "invalid-response" });
  await assert.rejects(createSefinHomologation({
    ...mock, identity: { ...identity, fingerprint: "other" },
  }, ledger).submit(document), { code: "certificate-holder-mismatch" });
  assert.equal(posts, 0);
});

test("unexpected DPS lookup reports only allowlisted metadata and prevents a POST", async (t) => {
  const { ledger } = await journal(t);
  const mock = transport(async (method) => {
    assert.equal(method, "GET");
    return {
      status: 404,
      format: "json",
      body: {
        tipoAmbiente: 0,
        dataHoraProcessamento: timestamp,
        erro: { codigo: "E2404", descricao: "dados internos" },
        campoPrivado: "conteúdo que não deve aparecer",
      },
    };
  });
  await assert.rejects(createSefinHomologation(mock, ledger).submit(document), {
    code: "invalid-response",
    diagnostico: {
      operacao: "consultar-dps",
      httpStatus: 404,
      formato: "json",
      campos: ["tipoAmbiente", "dataHoraProcessamento", "erro"],
      camposInvalidos: ["tipoAmbiente", "versaoAplicativo"],
      tipoAmbiente: 0,
      idDps: "ausente",
      codigos: ["E2404"],
    },
  });
});

test("the abbreviated SEFIN E2404 response allows submission only for an unused DPS", async (t) => {
  const { ledger } = await journal(t);
  const calls: string[] = [];
  const provider = createSefinHomologation(transport(async (method) => {
    calls.push(method);
    if (method === "GET") {
      return {
        status: 404,
        body: { tipoAmbiente: 0, dataHoraProcessamento: timestamp, erro: { codigo: "E2404" } },
      };
    }
    return authorized;
  }), ledger);
  assert.equal((await provider.submit(document)).state, "authorized");
  assert.deepEqual(calls, ["GET", "POST"]);
});

test("official rejection is reported with sanitized codes after reconciliation", async (t) => {
  const { ledger } = await journal(t);
  let queries = 0;
  const provider = createSefinHomologation(transport(async (method) => {
    if (method === "GET") {
      queries++;
      return notFound;
    }
    return { status: 400, body: { ...envelope, erros: [{ codigo: "E0004" }, { codigo: "confidential text" }] } };
  }), ledger);
  assert.deepEqual(await provider.submit(document), { state: "rejected", id, codes: ["E0004"], processadoEm: timestamp });
  assert.equal(queries, 2);
});

test("HTTP 201 without a matching homologation XML stays uncertain", async (t) => {
  const { ledger } = await journal(t);
  const provider = createSefinHomologation(transport(async (method) => method === "GET" ? notFound : {
    status: 201, body: { ...authorized.body, chaveAcesso: accessKey.replace(/1$/, "2") },
  }), ledger);
  assert.deepEqual(await provider.submit(document), { state: "indeterminate", id });
});
