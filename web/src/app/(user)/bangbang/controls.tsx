import type { ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes, ReactNode } from "react";

export function Button({ variant, className = "", type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "outline" | "ghost" }) {
    return (
        <button
            type={type}
            style={!variant ? { color: "var(--primary-foreground)" } : undefined}
            className={`inline-flex min-h-9 shrink-0 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 ${variant === "ghost" ? "border-transparent hover:bg-muted" : variant === "outline" ? "bg-background hover:bg-muted" : "border-primary bg-primary text-primary-foreground hover:bg-primary/90"} ${className}`}
            {...props}
        />
    );
}
export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
    return <input className={`h-10 w-full min-w-0 rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 ${className}`} {...props} />;
}
export function Textarea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
    return <textarea className={`min-h-28 w-full rounded-lg border bg-background p-3 text-sm leading-6 outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 ${className}`} {...props} />;
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <label className="block min-w-0 space-y-2">
            <span className="text-sm font-medium">{label}</span>
            {children}
        </label>
    );
}
