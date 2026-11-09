ALTER TABLE "Membership"
  ADD COLUMN "loginCpf" TEXT,
  ADD CONSTRAINT "Membership_login_cpf_check" CHECK (
    "loginCpf" IS NULL OR ("role" = 'OWNER' AND "loginCpf" ~ '^[0-9]{11}$')
  );
