import type { PropsWithChildren, ReactNode } from "react";
import { hoursLabel } from "../domain/time";

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Card({ children, className = "" }: PropsWithChildren<{ className?: string }>) {
  return <section className={`card ${className}`}>{children}</section>;
}

export function Hours({ minutes }: { minutes: number }) {
  return <>{hoursLabel(minutes)} 小时</>;
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-icon" aria-hidden="true">✓</span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function StatusPill({ tone, children }: PropsWithChildren<{ tone: "blue" | "green" | "amber" | "gray" | "red" }>) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}
