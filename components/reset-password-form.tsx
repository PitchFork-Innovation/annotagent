"use client";

import { FormEvent, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setIsSubmitting(true);

    const res = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });

    setIsSubmitting(false);

    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      setError(data.error ?? "Reset failed. The link may be invalid or expired.");
      return;
    }

    setNotice("Password updated. Redirecting to sign in...");
    setTimeout(() => router.push("/"), 1500);
  }

  if (!token) {
    return (
      <p className="font-mono text-[12px] text-ember">
        Invalid reset link. Please request a new one.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="font-display text-[1.6rem] font-light leading-tight text-linen">
        Set new password
      </h2>
      <form className="space-y-2" onSubmit={onSubmit}>
        <input
          className="h-10 w-full rounded border border-rim bg-shell/50 px-3 font-mono text-[12px] text-linen outline-none transition placeholder:text-fog focus:border-gold/50 focus:bg-shell"
          type="password"
          placeholder="new password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={6}
          required
        />
        <button
          className="h-10 w-full rounded bg-gold font-mono text-[11px] uppercase tracking-[0.24em] text-void transition hover:bg-gold/90 disabled:cursor-progress disabled:opacity-60"
          type="submit"
          disabled={isSubmitting}
        >
          {isSubmitting ? "..." : "Update password"}
        </button>
      </form>
      {error && (
        <p className="rounded border border-ember/30 bg-ember/[0.07] px-3 py-2 font-mono text-[11px] text-ember">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded border border-sea/30 bg-sea/[0.07] px-3 py-2 font-mono text-[11px] text-sea">
          {notice}
        </p>
      )}
    </div>
  );
}
