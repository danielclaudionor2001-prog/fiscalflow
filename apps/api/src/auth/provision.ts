import "dotenv/config";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { Prisma, PrismaClient, Role } from "@prisma/client";
import { z } from "zod";
import { lockActiveOrganization } from "../organizations/access.ts";
import { cpfSchema } from "../registrations/input.ts";
import { emailSchema, hashPassword, newPasswordSchema, organizationCnpjSchema } from "./credentials.ts";

const argsSchema = z.object({
  email: emailSchema,
  cnpj: organizationCnpjSchema.optional(),
  cpf: cpfSchema.optional(),
  role: z.enum(Role),
  name: z.string().trim().min(1).max(120).optional(),
  company: z.string().trim().min(1).max(160).optional(),
}).refine(({ cnpj, cpf }) => Boolean(cnpj) !== Boolean(cpf));

class ProvisionError extends Error {}

async function readPassword() {
  const terminal = Boolean(stdin.isTTY);
  const silent = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const input = createInterface({ input: stdin, output: terminal ? silent : undefined, terminal });
  input.on("SIGINT", () => input.close());
  const lines = input[Symbol.asyncIterator]();

  try {
    if (terminal) stdout.write("Senha inicial (mínimo de 15 caracteres): ");
    const first = await lines.next();
    const password = newPasswordSchema.safeParse(first.value);
    if (!password.success) throw new ProvisionError("Forneça uma senha de 15 a 128 caracteres.");
    if (terminal) {
      stdout.write("\nConfirme a senha: ");
      const confirmation = await lines.next();
      if (confirmation.value !== password.data) throw new ProvisionError("As senhas não conferem.");
    }
    return password.data;
  } finally {
    input.close();
    if (terminal) stdout.write("\n");
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      cnpj: { type: "string" },
      cpf: { type: "string" },
      role: { type: "string" },
      name: { type: "string" },
      company: { type: "string" },
      "platform-owner": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log("npm run auth:provision -- (--cnpj CNPJ | --cpf CPF) --email EMAIL --role PAPEL [--company NOME] [--name RESPONSÁVEL]");
    console.log("Use --role OWNER --platform-owner para promover um vínculo de proprietário existente.");
    return;
  }
  const input = argsSchema.safeParse(values);
  if (!input.success) throw new ProvisionError("Informe CPF ou CNPJ, e-mail e papel válidos. Use --help para ver os parâmetros.");

  const { cnpj, cpf, email, role, company, name } = input.data;
  const prisma = new PrismaClient();
  try {
    const [organization, user] = await Promise.all([
      prisma.organization.findUnique({ where: cpf ? { cpf } : { cnpj }, select: { id: true, archivedAt: true } }),
      prisma.user.findUnique({ where: { email }, select: { id: true } }),
    ]);
    if (organization?.archivedAt) throw new ProvisionError("A organização está arquivada.");
    if (values["platform-owner"]) {
      if (!organization || !user || role !== Role.OWNER) throw new ProvisionError("Informe um proprietário já cadastrado.");
      await prisma.$transaction(async (tx) => {
        if (!await lockActiveOrganization(tx, organization.id)) throw new ProvisionError("A organização está indisponível.");
        const membership = await tx.membership.findUnique({
          where: { userId_organizationId: { organizationId: organization.id, userId: user.id } },
          select: { id: true, role: true },
        });
        if (membership?.role !== Role.OWNER) throw new ProvisionError("O vínculo precisa ter o papel OWNER.");
        const updated = await tx.membership.updateMany({
          where: { id: membership.id, platformOwner: false }, data: { platformOwner: true },
        });
        if (!updated.count) return;
        await tx.registrationAuditEvent.create({
          data: { organizationId: organization.id, entity: "MEMBERSHIP", entityId: membership.id, action: "UPDATED" },
        });
      });
      console.log("Acesso de proprietário da plataforma habilitado para este vínculo.");
      return;
    }
    if (!organization && (!company || role !== Role.OWNER)) {
      throw new ProvisionError("Uma empresa nova exige --company e o primeiro vínculo com papel OWNER.");
    }
    if (!user && !name) throw new ProvisionError("Informe --name para criar uma identidade nova.");

    const newUser = user ? undefined : { email, name: name!, passwordHash: await hashPassword(await readPassword()) };
    await prisma.$transaction(async (tx) => {
      if (organization && !await lockActiveOrganization(tx, organization.id)) {
        throw new ProvisionError("A organização está arquivada ou indisponível.");
      }
      const tenant = organization ?? await tx.organization.create({
        data: { cnpj, cpf, legalName: company! },
        select: { id: true },
      });
      const identity = user ?? await tx.user.create({ data: newUser!, select: { id: true } });
      const organizationId = tenant.id;
      const userId = identity.id;
      await tx.membership.create({ data: { organizationId, userId, role } });
      await tx.authAuditEvent.create({ data: { organizationId, userId, action: "MEMBERSHIP_PROVISIONED" } });
    });
    console.log(`Vínculo criado com o papel ${role}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ProvisionError) {
    console.error(error.message);
  } else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    console.error("O vínculo já existe ou houve um provisionamento concorrente. Nenhum dado foi sobrescrito.");
  } else {
    console.error("Não foi possível provisionar o acesso. Confira os parâmetros e a conexão com o banco.");
  }
  process.exitCode = 1;
});
