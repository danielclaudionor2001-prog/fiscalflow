import { open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { loadHomologationCredential, loadHomologationSigningKey } from "./certificate.ts";
import { signHomologationDps, validateDps } from "./documents.ts";
import { createUnsignedDps, dpsDraftTemplate, readDpsDraft } from "./dps-draft.ts";
import { FiscalError, maxPfxBytes, maxXmlBytes } from "./errors.ts";
import { fileLedger } from "./ledger.ts";
import { createSefinHomologation, type FiscalNote } from "./sefin.ts";
import { sefinTransport } from "./sefin-transport.ts";

const cwd = process.env.INIT_CWD || process.cwd();
const help = [
  "npm run nfse:homologacao -- modelo --saida dps-dados.json",
  "npm run nfse:homologacao -- gerar --dados dps-dados.json --pfx certificado.pfx --saida DPS-assinada.xml",
  "npm run nfse:homologacao -- validar --arquivo DPS.xml",
  "npm run nfse:homologacao -- consultar-dps --id DPS... --pfx certificado.pfx",
  "npm run nfse:homologacao -- consultar-nfse --chave CHAVE --pfx certificado.pfx [--saida nfse.xml]",
  "npm run nfse:homologacao -- enviar --arquivo DPS.xml --pfx certificado.pfx [--estado DIRETORIO] [--saida nfse.xml]",
].join("\n");

function required(value: string | undefined, flag: string) {
  if (!value?.trim()) throw new FiscalError("invalid-arguments", `Informe --${flag}.`);
  return value;
}

async function boundedFile(path: string, limit: number) {
  try {
    const handle = await open(resolve(cwd, path), "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || !stat.size || stat.size > limit) throw new Error();
      const buffer = Buffer.allocUnsafe(stat.size + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size !== stat.size) throw new Error();
      return buffer.subarray(0, size);
    } finally {
      await handle.close();
    }
  } catch {
    throw new FiscalError("input-file", "O arquivo de entrada está inacessível, vazio ou fora do limite de tamanho.");
  }
}

async function readPassphrase() {
  const terminal = Boolean(stdin.isTTY);
  const silent = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const input = createInterface({ input: stdin, output: terminal ? silent : undefined, terminal });
  input.on("SIGINT", () => input.close());
  try {
    if (terminal) stdout.write("Senha do certificado A1: ");
    const { value } = await input[Symbol.asyncIterator]().next();
    if (typeof value !== "string" || !value.length || value.length > 1024) {
      throw new FiscalError("missing-passphrase", "Informe a senha do A1 pelo terminal ou pela entrada padrão.");
    }
    return value;
  } finally {
    input.close();
    if (terminal) stdout.write("\n");
  }
}

async function writeNewFile(
  destination: string,
  contents: string | Buffer,
  message = "Use um caminho de saída livre em uma pasta existente e gravável.",
) {
  const file = resolve(cwd, destination);
  try {
    await writeFile(file, contents, { flag: "wx", mode: 0o600 });
  } catch {
    throw new FiscalError("output-file", message);
  }
  return file;
}

async function reportNote(state: string, note: FiscalNote, destination?: string) {
  console.log(JSON.stringify({ state, idDps: note.dpsId, chaveAcesso: note.accessKey }));
  if (destination) {
    await writeNewFile(destination, note.xml, "O XML foi obtido, mas o arquivo de saída está indisponível ou já existe.");
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      arquivo: { type: "string" },
      dados: { type: "string" },
      pfx: { type: "string" },
      id: { type: "string" },
      chave: { type: "string" },
      estado: { type: "string" },
      saida: { type: "string" },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log(help);
    return;
  }
  const [command] = positionals;
  if (positionals.length !== 1 || !["modelo", "gerar", "validar", "consultar-dps", "consultar-nfse", "enviar"].includes(command)) {
    throw new FiscalError("invalid-arguments", "Comando inválido. Consulte --help.");
  }

  if (command === "modelo") {
    const destination = required(values.saida, "saida");
    await writeNewFile(destination, JSON.stringify(dpsDraftTemplate, null, 2) + "\n");
    console.log(JSON.stringify({ state: "template-created" }));
    return;
  }

  if (command === "gerar") {
    const destination = required(values.saida, "saida");
    const data = readDpsDraft(await boundedFile(required(values.dados, "dados"), 32 * 1024));
    const pfx = await boundedFile(required(values.pfx, "pfx"), maxPfxBytes);
    try {
      const key = loadHomologationSigningKey(pfx, await readPassphrase());
      const { id, xml } = signHomologationDps(createUnsignedDps(data), key);
      const file = await writeNewFile(destination, xml);
      console.log(JSON.stringify({ state: "locally-signed", idDps: id, arquivo: file }));
    } finally {
      pfx.fill(0);
    }
    return;
  }

  if (command === "validar") {
    const xml = await boundedFile(required(values.arquivo, "arquivo"), maxXmlBytes);
    const { id } = validateDps(xml);
    console.log(JSON.stringify({ state: "locally-validated", idDps: id }));
    return;
  }

  // Validate inputs before reading a credential or opening the connection.
  const target = command === "consultar-dps" ? required(values.id, "id")
    : command === "consultar-nfse" ? required(values.chave, "chave")
    : required(values.arquivo, "arquivo");
  const document = command === "enviar" ? await boundedFile(target, maxXmlBytes) : undefined;
  const pfx = await boundedFile(required(values.pfx, "pfx"), maxPfxBytes);
  try {
    const credential = loadHomologationCredential(pfx, await readPassphrase());
    const provider = createSefinHomologation(sefinTransport(credential), fileLedger(resolve(cwd, values.estado ?? ".nfse-homologacao")));
    if (document) {
      const result = await provider.submit(document);
      if ("note" in result) await reportNote(result.state, result.note, values.saida);
      else {
        console.log(JSON.stringify(result));
        process.exitCode = result.state === "indeterminate" ? 3 : 2;
      }
    } else if (command === "consultar-dps") {
      const result = await provider.lookup(target);
      console.log(JSON.stringify(result ? { state: "found", idDps: result.id, chaveAcesso: result.accessKey } : { state: "not-found", idDps: target }));
    } else {
      await reportNote("found", await provider.getNote(target), values.saida);
    }
  } finally {
    pfx.fill(0);
  }
}

function safeCliError(error: unknown) {
  if (error instanceof FiscalError) return error;
  if (error instanceof Error && "code" in error) {
    if (error.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      return new FiscalError("invalid-arguments", "Informe um valor após cada opção. Para --pfx, use o caminho completo do certificado A1.");
    }
    if (error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      return new FiscalError("invalid-arguments", "Opção desconhecida. Execute um comando por vez e consulte --help.");
    }
  }
  return new FiscalError("fiscal-operation", "Não foi possível concluir a operação. Confira --help e a configuração local.");
}

main().catch((error: unknown) => {
  const safe = safeCliError(error);
  console.error(JSON.stringify({ code: safe.code, message: safe.message, diagnostico: safe.diagnostico }));
  process.exitCode = 1;
});
