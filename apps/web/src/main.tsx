import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AuthGate, type SignedIn } from "./auth";
import { BoletosPage } from "./billing/boletos";
import { ReceivingAccountPage } from "./billing/receiving-account";
import { CustomerInvoicePage } from "./invoices/customer-history";
import { InvoiceDraftsPage } from "./invoices/drafts";
import { IssuancePanel } from "./invoices/issuance-summary";
import { NotesPage } from "./invoices/notes";
import { InvoiceReportsPage } from "./invoices/reports";
import { InvoiceSchedulesPage } from "./invoices/schedules";
import { CertificatesPage } from "./organizations/certificates";
import { TeamPage } from "./organizations/team";
import { PlatformPage } from "./organizations/platform";
import { CatalogPage } from "./registrations/catalog";
import { OrganizationPage } from "./registrations/organization";
import { Brand, FiscalIllustration, Icon, type IconName } from "./ui";
import "./style.css";
import "./registrations/style.css";

const pages = {
  "visao-geral": { label: "Visão geral", icon: "home", description: "Acesse os principais recursos da sua empresa." },
  organizacao: { label: "Organização", icon: "building", description: "Consulte e atualize os dados da empresa." },
  clientes: { label: "Clientes", icon: "clients", description: "Gerencie seus clientes e consulte as notas de cada um." },
  servicos: { label: "Serviços", icon: "services", description: "Organize os serviços, valores padrão e códigos fiscais." },
  "notas-fiscais": { label: "Notas fiscais", icon: "document", description: "Crie uma nota avulsa ou configure a preparação mensal." },
  rascunhos: { label: "Rascunhos", icon: "drafts", description: "Revise as informações das notas e prepare suas DPS." },
  recorrencias: { label: "Recorrências", icon: "repeat", description: "Acompanhe a geração mensal de rascunhos por cliente." },
  relatorios: { label: "Relatórios", icon: "report", description: "Consulte e exporte os totais de rascunhos por período." },
  equipe: { label: "Equipe", icon: "shield", description: "Consulte quem tem acesso à empresa e os papéis de cada pessoa." },
  certificados: { label: "Certificados", icon: "key", description: "Confira o e-CNPJ A1 e sua validade." },
  plataforma: { label: "Empresas assinantes", icon: "building", description: "Cadastre empresas e administre o acesso ao FiscalFlow." },
  boletos: { label: "Boletos", icon: "document", description: "Vincule cobranças às notas e acompanhe os recebimentos." },
  recebimento: { label: "Conta de recebimento", icon: "building", description: "Informe a conta da empresa onde você confere os créditos." },
  assinaturas: { label: "Cobranças de assinatura", icon: "document", description: "Acompanhe as cobranças do FiscalFlow para a empresa assinante." },
  "conta-assinaturas": { label: "Conta das assinaturas", icon: "building", description: "Configure a conta que recebe as assinaturas do FiscalFlow." },
} satisfies Record<string, { label: string; icon: IconName; description: string }>;
type Page = keyof typeof pages;

const navigationGroups: { title: string; pages: Page[] }[] = [
  { title: "Painel", pages: ["visao-geral", "relatorios"] },
  { title: "Fiscal", pages: ["notas-fiscais", "rascunhos", "recorrencias"] },
  { title: "Financeiro", pages: ["boletos", "recebimento"] },
  { title: "Cadastros", pages: ["clientes", "servicos"] },
  { title: "Empresa", pages: ["organizacao", "certificados", "equipe"] },
  { title: "Plataforma", pages: ["plataforma", "conta-assinaturas"] },
];

function Overview({ canDraft, canManage, organizationId, endSession }: {
  canDraft: boolean; canManage: boolean; organizationId: string; endSession: () => void;
}) {
  const shortcuts: Page[] = ["clientes", "rascunhos", "servicos", canManage ? "recorrencias" : "organizacao"];
  return (
    <div className="overview">
      <IssuancePanel key={organizationId} organizationId={organizationId} endSession={endSession} />
      <div className="overview-intro">
        <section className="overview-hero" aria-labelledby="overview-hero-title">
          <div className="hero-copy">
            <span className="hero-label">GESTÃO DE NFS-e</span>
            <h2 id="overview-hero-title">Organize sua rotina fiscal</h2>
            <p>Prepare suas notas avulsas e mensais e acompanhe os documentos por cliente.</p>
            <div className="hero-actions">
              {canDraft && <a className="button hero-primary" href="#notas-fiscais?nova=avulsa"><Icon name="plus" />Nova nota avulsa</a>}
              <a className="button hero-secondary" href="#rascunhos">Ver rascunhos<Icon name="arrow" /></a>
            </div>
          </div>
          <FiscalIllustration />
        </section>
        <section className="fiscal-status" aria-labelledby="fiscal-status-title">
          <span className="status-icon"><Icon name="clock" /></span>
          <h2 id="fiscal-status-title">Ambiente fiscal</h2>
          <span className="status-badge">Homologação pendente</span>
          <p>Você pode preparar e assinar DPS de teste. A transmissão fiscal depende da homologação.</p>
        </section>
      </div>
      <section className="overview-shortcuts" aria-labelledby="shortcuts-title">
        <h2 id="shortcuts-title">Acesso rápido</h2>
        <div className="shortcut-grid">
          {shortcuts.map((id) => (
            <a className="shortcut-card" key={id} href={"#" + id}>
              <span className="shortcut-icon"><Icon name={pages[id].icon} /></span>
              <div><h3>{pages[id].label}</h3><p>{pages[id].description}</p></div>
              <span className="shortcut-arrow"><Icon name="arrow" /></span>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}

function Dashboard({ account, role, platformOwner, organizationId, endSession, renameOrganization }: SignedIn) {
  const [hash, setHash] = useState(() => window.location.hash.slice(1));
  const [menuOpen, setMenuOpen] = useState(false);
  const [section, search] = hash.split("?");
  const page = Object.hasOwn(pages, section) ? section as Page : "visao-geral";
  const query = new URLSearchParams(search);
  const customerId = page === "clientes" ? query.get("notas") : null;
  const invoiceId = page === "boletos" ? query.get("nota") : null;
  const subscriberId = page === "assinaturas" ? query.get("empresa") : null;
  const canViewTeam = role === "OWNER" || role === "ADMIN";
  const canViewReports = canViewTeam || role === "ACCOUNTANT";
  const navigation = navigationGroups.map((group) => ({
    ...group,
    pages: group.pages
      .filter((id) => (id !== "equipe" && id !== "recorrencias" && id !== "certificados") || canViewTeam)
      .filter((id) => id !== "relatorios" || canViewReports)
      .filter((id) => id !== "boletos" || canViewReports)
      .filter((id) => id !== "recebimento" || role === "OWNER")
      .filter((id) => (id !== "plataforma" && id !== "conta-assinaturas") || platformOwner),
  })).filter((group) => group.pages.length > 0);
  useEffect(() => {
    const navigate = () => {
      setHash(window.location.hash.slice(1));
      setMenuOpen(false);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, []);

  return (
    <div className="layout">
      <a className="skip-link" href="#conteudo" onClick={(event) => {
        event.preventDefault();
        document.getElementById("conteudo")?.focus();
      }}>Ir para o conteúdo</a>
      <aside className="sidebar" data-menu-open={menuOpen}>
        <div className="sidebar-header">
          <a className="sidebar-brand" href="#visao-geral" onClick={() => setMenuOpen(false)}><Brand /></a>
          <button className="menu-toggle" type="button" aria-controls="main-navigation" aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}>
            <Icon name={menuOpen ? "close" : "menu"} />Menu
          </button>
        </div>
        <nav className="sidebar-nav" id="main-navigation" aria-label="Navegação principal">
          {navigation.map((group) => (
            <div className="nav-group" key={group.title}>
              <p className="nav-group-title">{group.title}</p>
              {group.pages.map((id) => (
                <a key={id} href={"#" + id} aria-current={page === id ? "page" : undefined} onClick={() => {
                  if (menuOpen) document.getElementById("conteudo")?.focus({ preventScroll: true });
                  setMenuOpen(false);
                }}>
                  <Icon name={pages[id].icon} />{pages[id].label}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer"><Icon name="shield" /><span>Gestão fiscal<span>NFS-e Nacional</span></span></div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb"><Icon name="home" /><span>Painel</span><span aria-hidden="true">/</span><strong>{pages[page].label}</strong></div>
          {account}
        </header>
        <main className="page-content" id="conteudo" tabIndex={-1}>
          <div className="page-heading">
            <h1>{customerId ? "Histórico de notas" : pages[page].label}</h1>
            <p>{customerId ? "Consulte os documentos e PDFs disponíveis para este cliente." : pages[page].description}</p>
          </div>
          {page === "visao-geral" && <Overview canDraft={canViewTeam || role === "OPERATOR"} canManage={canViewTeam}
            organizationId={organizationId} endSession={endSession} />}
          {page === "organizacao" && <OrganizationPage role={role} organizationId={organizationId} endSession={endSession} renameOrganization={renameOrganization} />}
          {page === "clientes" && (customerId
            ? <CustomerInvoicePage key={organizationId + ":" + customerId} customerId={customerId} role={role} organizationId={organizationId} endSession={endSession} />
            : <CatalogPage key="customers" resource="customers" role={role} organizationId={organizationId} endSession={endSession} />)}
          {page === "servicos" && <CatalogPage key="services" resource="services" role={role} organizationId={organizationId} endSession={endSession} />}
          {page === "notas-fiscais" && <NotesPage key={organizationId} access={{ role, organizationId, endSession }} query={query} />}
          {page === "rascunhos" && <InvoiceDraftsPage key={organizationId} role={role} organizationId={organizationId} endSession={endSession} />}
          {page === "recorrencias" && (canViewTeam
            ? <InvoiceSchedulesPage key={organizationId} role={role} organizationId={organizationId} endSession={endSession} />
            : <p>Seu papel não permite gerenciar recorrências.</p>)}
          {page === "relatorios" && (canViewReports
            ? <InvoiceReportsPage key={organizationId} role={role} organizationId={organizationId} endSession={endSession} />
            : <p>Seu papel não permite consultar relatórios.</p>)}
          {page === "equipe" && (canViewTeam
            ? <TeamPage key={organizationId} role={role} organizationId={organizationId} endSession={endSession} />
            : <p>Seu papel não permite consultar a equipe.</p>)}
          {page === "certificados" && (canViewTeam
            ? <CertificatesPage key={organizationId} role={role} organizationId={organizationId} endSession={endSession} />
            : <p>Seu papel não permite consultar o certificado.</p>)}
          {page === "plataforma" && (platformOwner
            ? <PlatformPage key={organizationId} role={role} organizationId={organizationId} endSession={endSession} />
            : <p>Esta área é exclusiva do proprietário da plataforma.</p>)}
          {page === "boletos" && (canViewReports
            ? <BoletosPage key={organizationId + ":" + (invoiceId ?? "")} invoiceId={invoiceId} role={role} organizationId={organizationId} endSession={endSession} />
            : <p>Seu papel não permite consultar boletos.</p>)}
          {page === "recebimento" && (role === "OWNER"
            ? <ReceivingAccountPage key={organizationId} subscription={false} role={role} organizationId={organizationId} endSession={endSession} />
            : <p>Seu papel não permite alterar a conta de recebimento.</p>)}
          {page === "conta-assinaturas" && (platformOwner
            ? <ReceivingAccountPage key={organizationId} subscription role={role} organizationId={organizationId} endSession={endSession} />
            : <p>Esta área é exclusiva do proprietário da plataforma.</p>)}
          {page === "assinaturas" && (platformOwner && subscriberId
            ? <BoletosPage key={organizationId + ":" + subscriberId} companyId={subscriberId} role={role} organizationId={organizationId} endSession={endSession} />
            : <p>Selecione uma empresa assinante na área da plataforma.</p>)}
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <AuthGate>{(context) => <Dashboard {...context} />}</AuthGate>,
);
