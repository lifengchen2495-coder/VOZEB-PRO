import type { ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from "react";
export function Button({ variant, size, className = "", type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "outline" | "ghost"; size?: "sm" }) {
    return (
        <button
            type={type}
            style={!variant ? { color: "var(--primary-foreground)" } : undefined}
            className={`inline-flex shrink-0 items-center justify-center rounded-lg border text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 ${size === "sm" ? "h-8 px-3" : "h-10 px-4"} ${variant === "ghost" ? "border-transparent hover:bg-muted" : variant === "outline" ? "bg-background hover:bg-muted" : "border-primary bg-primary text-primary-foreground hover:bg-primary/90"} ${className}`}
            {...props}
        />
    );
}
export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
    return <input className={`h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 ${className}`} {...props} />;
}
export function Textarea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
    return <textarea className={`min-h-24 w-full rounded-lg border bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 ${className}`} {...props} />;
}
