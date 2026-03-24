"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

export function ResetPasswordForm() {
  const router = useRouter();
  const [supabase] = useState(() => createSupabaseBrowserClient());
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setIsSubmitting(true);
    const { error: authError } = await supabase.auth.updateUser({
      password
    });
    setIsSubmitting(false);

    if (authError) {
      setError(authError.message);
      return;
    }

    setNotice("Password updated successfully. Redirecting back to your library...");
    window.setTimeout(() => {
      router.push("/");
      router.refresh();
    }, 1200);
  }

  return (
    <main className="paper-grid min-h-screen px-6 py-8 text-night md:px-10">
      <div className="mx-auto max-w-xl rounded-[2rem] border border-black/10 bg-white/80 p-8 shadow-float backdrop-blur">
        <p className="text-xs uppercase tracking-[0.3em] text-ink/60">Reset password</p>
        <h1 className="mt-4 font-serif text-4xl leading-tight text-night">Set a new password</h1>
        <p className="mt-4 text-sm leading-7 text-night/65">
          If you previously used magic-link sign-in, this lets you create a password for future email/password login.
        </p>
        <form className="mt-8 space-y-4" onSubmit={onSubmit}>
          <input
            className="h-12 w-full rounded-2xl border border-black/10 bg-paper px-4 text-sm text-night outline-none transition placeholder:text-night/35 focus:border-ink/30"
            type="password"
            placeholder="New password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={6}
            required
          />
          <input
            className="h-12 w-full rounded-2xl border border-black/10 bg-paper px-4 text-sm text-night outline-none transition placeholder:text-night/35 focus:border-ink/30"
            type="password"
            placeholder="Confirm new password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            minLength={6}
            required
          />
          <button
            className={cn(
              "inline-flex h-12 w-full items-center justify-center rounded-2xl bg-ink px-4 text-sm font-semibold text-white transition hover:bg-ink/90",
              isSubmitting && "cursor-progress opacity-70"
            )}
            disabled={isSubmitting}
            type="submit"
          >
            {isSubmitting ? "Updating password..." : "Save new password"}
          </button>
        </form>
        {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}
        {notice ? <p className="mt-4 text-sm text-emerald-700">{notice}</p> : null}
      </div>
    </main>
  );
}
