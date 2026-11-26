"use client";

/**
 * M47 — shared studio primitives. Pages COMPOSE these; they never hand-style
 * panels, buttons or status text. Every visual token lives in globals.css
 * under the M47 design system block.
 */
import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes } from "react";

export function Panel({ children, className = "", ...rest }: { children: ReactNode; className?: string } & Record<string, unknown>) {
  return (
    <section className={`m47-panel ${className}`} {...rest}>
      {children}
    </section>
  );
}

export function PanelHead({ title, right, className = "" }: { title: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={`m47-panel-head ${className}`}>
      <h2 className="m47-title">{title}</h2>
      {right}
    </div>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost" | "danger";
};
export function Btn({ variant = "default", className = "", children, ...rest }: BtnProps) {
  const v = variant === "primary" ? "m47-btn-primary" : variant === "ghost" ? "m47-btn-ghost" : variant === "danger" ? "m47-btn-danger" : "";
  return (
    <button className={`m47-btn ${v} ${className}`} {...rest}>
      {children}
    </button>
  );
}

export function StatusBadge({ s, children }: { s: "ok" | "run" | "fail" | "idle" | "det"; children: ReactNode }) {
  return <span className="m47-status" data-s={s}>{children}</span>;
}

export const statusSense = (state: string): "ok" | "run" | "fail" | "idle" | "det" =>
  state === "SUCCEEDED" || state === "COMPLETED" ? "ok"
  : state === "RUNNING" || state === "AWAITING_APPROVAL" || state === "READY" ? "run"
  : state === "FAILED" || state === "REJECTED" ? "fail"
  : state === "DETERMINISTIC" ? "det"
  : "idle";

export function Empty({ children }: { children: ReactNode }) {
  return <div className="m47-empty">{children}</div>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`m47-skeleton ${className}`} aria-hidden="true" />;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-md border border-[#7f1d1d] bg-[#1a0d0d] px-3 py-2 text-[11px] text-[#f8a5a5]">
      {children}
    </p>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="m47-kbd">{children}</kbd>;
}

export function AgentDot({ agent }: { agent: string }) {
  const key = (agent || "").split(" ")[0].toUpperCase().replace(/[^A-Z]/g, "");
  const cls = ["RIISHE", "NIIKI", "GANGZII", "JAZMII", "LAXII"].includes(key) ? `m47-agent-${key}` : "m47-agent-RIISHE";
  return <span className={`m47-agent-dot ${cls}`} aria-hidden="true" />;
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`m47-input px-2.5 py-1.5 ${props.className ?? ""}`} {...props} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`m47-textarea px-2.5 py-2 ${props.className ?? ""}`} {...props} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`m47-select px-2 py-1.5 ${props.className ?? ""}`} {...props} />;
}

/** Mode disclosure — deterministic / LLM / provider / manual, in one honest line. */
export function ModeTag({ mode }: { mode: string | null | undefined }) {
  if (!mode) return null;
  const s: "ok" | "run" | "fail" | "idle" | "det" =
    mode.startsWith("deterministic") ? "det" : mode.includes("llm") ? "run" : mode.includes("provider") ? "run" : mode.includes("job") || mode.includes("qa") ? "idle" : "det";
  return <StatusBadge s={s}>{mode}</StatusBadge>;
}
