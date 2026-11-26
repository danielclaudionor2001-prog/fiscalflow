import { useEffect, useRef } from "react";
import { FiscalIllustration, Icon, type IconName } from "./ui";
import "./landing.css";

const features: { icon: IconName; title: string; text: string; tag: string }[] = [
  { icon: "document", title: "Notas fiscais sem complicar a rotina", text: "Prepare notas avulsas, confira os dados e acompanhe a autorização da NFS-e Nacional. Consulte o histórico e baixe o PDF.", tag: "NFS-e Nacional" },
  { icon: "drafts", title: "Orçamentos com a sua identidade", text: "Use seu logo, personalize a proposta e compartilhe um link para o cliente aprovar ou recusar. Aproveite documentos do Word.", tag: "Orçamento Express" },
  { icon: "clients", title: "Cada cliente, tudo no lugar", text: "Organize documentos, contatos, serviços e notas por cliente. Busque por CPF ou CNPJ na preparação da nota.", tag: "Cadastro e histórico" },
  { icon: "repeat", title: "Uma rotina mensal organizada", text: "Programe mensalidades por cliente e serviço. Confira as condições da emissão automática e acompanhe cada execução.", tag: "Recorrências" },
  { icon: "building", title: "Cobranças ligadas às suas notas", text: "Conecte a conta Asaas da sua empresa, planeje vencimentos e confira os dados antes de autorizar um boleto real.", tag: "Integração Asaas" },
  { icon: "report", title: "Mais clareza para decidir", text: "Acompanhe as emissões do mês, consulte relatórios e transforme suas planilhas em gráficos para entender os resultados.", tag: "Painéis e planilhas" },
];
const steps = [
  { number: "01", title: "Ative o seu acesso", text: "Receba o convite, crie sua senha e entre na conta da sua empresa." },
  { number: "02", title: "Organize a sua empresa", text: "Cadastre seus dados, clientes e serviços. Personalize a marca nos orçamentos." },
  { number: "03", title: "Prepare a operação", text: "Cadastre o A1 e confira os parâmetros fiscais e o credenciamento para emitir." },
  { number: "04", title: "Acompanhe tudo pelo painel", text: "Revise notas, consulte documentos e acompanhe propostas, mensalidades e cobranças." },
];

export function LandingPage() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!root.current || !("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const container = root.current;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) {
        (entry.target as HTMLElement).dataset.visible = "true"; observer.unobserve(entry.target);
      }
    }, { threshold: .08 });
    container.dataset.motion = "true";
    container.querySelectorAll("[data-reveal]").forEach((element) => observer.observe(element));
    return () => { observer.disconnect(); delete container.dataset.motion; };
  }, []);
  return <div className="landing" ref={root}>
    <a className="skip-link" href="#apresentacao">Ir para o conteúdo</a>
    <header className="landing-header"><div className="landing-nav">
      <a className="landing-brand" href="#inicio" aria-label="Fiscal Floow — início"><img src="/fiscal-floow-logo.png" width="189" height="63" alt="Fiscal Floow" /></a>
      <nav aria-label="Apresentação do Fiscal Floow"><a href="#recursos">Recursos</a><a href="#como-funciona">Como funciona</a><a href="#duvidas">Dúvidas</a></nav>
      <a className="button landing-login" href="#entrar">Entrar</a>
    </div></header>
    <main id="apresentacao">
      <section className="landing-hero landing-container" id="inicio">
        <div className="landing-hero-copy">
          <span className="landing-eyebrow"><span />GESTÃO FISCAL E COMERCIAL ONLINE</span>
          <h1>Mais controle.<br /><span>Mais tempo para<br className="landing-wide-break" /> a sua empresa.</span></h1>
          <p>Da proposta à nota fiscal, organize sua rotina em um só lugar. Clientes, orçamentos, NFS-e e cobranças com uma experiência simples de usar.</p>
          <div className="landing-actions"><a className="button landing-primary" href="#como-funciona">Veja como funciona</a><a className="landing-secondary" href="#recursos">Explore os recursos</a></div>
          <div className="landing-hero-trust"><span><Icon name="shield" />Acessos por empresa</span><span><Icon name="key" />Certificado A1 protegido</span></div>
        </div>
        <div className="landing-art" aria-label="Ilustração de documentos e etapas da rotina empresarial">
          <span className="landing-orbit landing-orbit-one" /><span className="landing-orbit landing-orbit-two" />
          <div className="landing-art-main"><span className="landing-art-label"><Icon name="document" />Sua rotina, conectada</span><FiscalIllustration />
            <div className="landing-process"><span>Cliente</span><Icon name="arrow" /><span>Serviço</span><Icon name="arrow" /><span>NFS-e</span></div>
          </div>
          <div className="landing-float landing-float-top"><span className="landing-float-icon"><Icon name="drafts" /></span><div><strong>Propostas com a sua marca</strong><small>Logo, PDF e aprovação por link</small></div></div>
          <div className="landing-float landing-float-bottom"><span className="landing-float-icon landing-mint"><Icon name="report" /></span><div><strong>Uma visão mais clara</strong><small>Notas e valores do mês no painel</small></div></div>
        </div>
      </section>
      <div className="landing-ribbon"><div className="landing-container"><span>Do primeiro cadastro ao acompanhamento da sua operação</span><span>NFS-e<small>+</small>Orçamentos<small>+</small>Clientes<small>+</small>Cobranças</span></div></div>
      <section className="landing-section landing-container" id="recursos">
        <div className="landing-section-heading" data-reveal><span className="landing-eyebrow">MENOS SISTEMAS SOLTOS. MAIS ORGANIZAÇÃO.</span><h2>Ferramentas que acompanham<br />o seu dia a dia.</h2><p>Conecte as etapas do trabalho e encontre as informações que precisa, quando precisa.</p></div>
        <div className="landing-feature-grid">{features.map((feature, index) => <article key={feature.title} className="landing-feature" data-reveal style={{ transitionDelay: `${index % 3 * 70}ms` }}>
          <span className="landing-feature-icon"><Icon name={feature.icon} /></span><small>{feature.tag}</small><h3>{feature.title}</h3><p>{feature.text}</p>
        </article>)}</div>
      </section>
      <section className="landing-how" id="como-funciona"><div className="landing-container landing-section">
        <div className="landing-section-heading" data-reveal><span className="landing-eyebrow">UM COMEÇO SIMPLES</span><h2>Entenda o caminho.<br />Depois, faça do seu jeito.</h2><p>O Fiscal Floow reúne as etapas da operação sem esconder o que precisa ser conferido.</p></div>
        <ol className="landing-steps">{steps.map((step) => <li key={step.number} data-reveal><span>{step.number}</span><h3>{step.title}</h3><p>{step.text}</p></li>)}</ol>
        <div className="landing-note" data-reveal><Icon name="shield" /><p>A emissão de notas reais depende de certificado válido, credenciamento do contribuinte e liberação da empresa na plataforma. Os dados fiscais precisam corresponder à operação realizada.</p></div>
      </div></section>
      <section className="landing-section landing-container landing-security" data-reveal>
        <div><span className="landing-eyebrow">CADA EMPRESA NO SEU ESPAÇO</span><h2>Uma plataforma para trabalhar<br />com organização e confiança.</h2><p>Defina quem acessa a sua conta, mantenha o certificado protegido e acompanhe o histórico das operações.</p><a className="landing-text-link" href="#entrar">Acessar minha empresa</a></div>
        <ul><li><Icon name="building" /><div><strong>Dados separados por empresa</strong><span>Clientes, documentos e configurações vinculados à conta certa.</span></div></li><li><Icon name="shield" /><div><strong>Perfis de acesso para a equipe</strong><span>Permissões para cada responsabilidade na operação.</span></div></li><li><Icon name="key" /><div><strong>Proteção do certificado A1</strong><span>Armazenamento criptografado e acompanhamento da validade.</span></div></li></ul>
      </section>
      <section className="landing-section landing-container landing-faq" id="duvidas" data-reveal>
        <div className="landing-section-heading"><span className="landing-eyebrow">ANTES DE COMEÇAR</span><h2>Suas dúvidas, sem complicação.</h2></div>
        <details><summary>Como recebo acesso ao Fiscal Floow?</summary><p>O responsável pela plataforma cadastra a sua empresa e envia um convite de primeiro acesso. Você define sua senha e entra com o CPF ou CNPJ e o e-mail cadastrados.</p></details>
        <details><summary>Posso emitir notas apenas cadastrando o certificado?</summary><p>O A1 é uma das etapas. A empresa também precisa estar credenciada para emitir pela API da NFS-e Nacional, ter os dados fiscais conferidos e estar liberada na plataforma.</p></details>
        <details><summary>Consigo personalizar os meus orçamentos?</summary><p>Sim. Cadastre o logo e, se desejar, uma imagem própria de marca d’água. O orçamento pode ser compartilhado por link para aprovação ou recusa pelo cliente.</p></details>
        <details><summary>Como funciona a cobrança pelo Asaas?</summary><p>Cada empresa conecta sua própria conta. O Fiscal Floow permite planejar a cobrança vinculada à nota e revisar os dados antes de autorizar a geração do boleto. Os ambientes de teste e de produção ficam separados.</p></details>
        <details><summary>Preciso instalar um programa para começar?</summary><p>Você pode acessar pelo navegador no computador ou no celular. No Chrome, também pode instalar o Fiscal Floow como aplicativo para criar um atalho de acesso.</p></details>
      </section>
      <section className="landing-container landing-final" data-reveal><div><span className="landing-eyebrow">SUA PRÓXIMA ETAPA, MAIS SIMPLES</span><h2>Sua empresa merece<br />uma rotina que flui.</h2><p>Já recebeu seu acesso? Entre e comece a organizar sua operação.</p></div><a className="button" href="#entrar">Entrar no Fiscal Floow</a></section>
    </main>
    <footer className="landing-footer landing-container"><img src="/fiscal-floow-logo.png" width="150" height="50" alt="Fiscal Floow" loading="lazy" /><p>Gestão fiscal e comercial para sua empresa.</p><span>© {new Date().getFullYear()} Fiscal Floow</span><a href="#entrar">Área do cliente</a></footer>
  </div>;
}
