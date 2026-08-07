import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  LabelHTMLAttributes,
} from "react";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return (
    <input
      {...rest}
      className={`w-full rounded-lg border border-edge bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-faint outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/30 ${className}`}
    />
  );
}

export function Label(props: LabelHTMLAttributes<HTMLLabelElement>) {
  const { className = "", ...rest } = props;
  return (
    <label
      {...rest}
      className={`mb-1.5 block text-xs font-semibold text-muted ${className}`}
    />
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
};

export function Button({ variant = "primary", className = "", ...rest }: ButtonProps) {
  const styles = {
    primary:
      "bg-accent text-bg font-semibold hover:bg-accent/90 disabled:opacity-50",
    secondary:
      "border border-edge bg-card text-ink hover:border-faint disabled:opacity-50",
    danger:
      "border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20 disabled:opacity-50",
    ghost: "text-muted hover:text-ink disabled:opacity-50",
  }[variant];
  return (
    <button
      {...rest}
      className={`rounded-lg px-4 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed ${styles} ${className}`}
    />
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
      {children}
    </p>
  );
}

export function SuccessNote({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p className="rounded-lg border border-ok/40 bg-ok/10 px-3 py-2 text-xs text-ok">
      {children}
    </p>
  );
}
