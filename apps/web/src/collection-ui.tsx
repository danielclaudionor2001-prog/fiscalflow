import type { ReactNode } from "react";
import { Icon, type IconName } from "./ui";

export type StatusTone = "positive" | "warning" | "negative" | "info" | "neutral";

export function StatusPill({ tone = "neutral", children }: { tone?: StatusTone; children: ReactNode }) {
  return <span className="collection-status" data-tone={tone}><i aria-hidden="true" />{children}</span>;
}

export function CollectionHeading({ icon, title, description, children }: {
  icon: IconName; title: string; description?: string; children?: ReactNode;
}) {
  return <div className="collection-heading">
    <div className="collection-heading-copy"><span className="collection-icon"><Icon name={icon} /></span>
      <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
    </div>
    {children && <div className="collection-heading-actions">{children}</div>}
  </div>;
}

export function EmptyCollection({ icon, title, description, children }: {
  icon: IconName; title: string; description: string; children?: ReactNode;
}) {
  return <div className="collection-empty">
    <span className="collection-empty-art" aria-hidden="true"><Icon name={icon} /></span>
    <h3>{title}</h3><p>{description}</p>
    {children && <div className="record-actions">{children}</div>}
  </div>;
}

export function EntityTitle({ name, detail, icon }: { name: string; detail?: ReactNode; icon?: IconName }) {
  return <div className="collection-entity">
    <span className="collection-avatar" aria-hidden="true">{icon ? <Icon name={icon} /> : name.trim().slice(0, 2).toLocaleUpperCase("pt-BR")}</span>
    <div><strong>{name}</strong>{detail && <small>{detail}</small>}</div>
  </div>;
}

export function PageCount({ count, page }: { count: number; page: number }) {
  return <span className="collection-count">{count} {count === 1 ? "registro" : "registros"} · página {page}</span>;
}
