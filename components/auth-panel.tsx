"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { UserProfile } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  user: UserProfile | null;
  hasAuthError?: boolean;
};

export function AuthPanel({ user, hasAuthError = false }: Props) {
  const router = useRouter();
  const [supabase] = useState(() => createSupabaseBrowserClient());
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(
    hasAuthError ? "Authentication failed. Try signing in again." : null
  );
  const [error, setError] = useState<string | null>(null);

  async function onSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setIsSubmitting(true);

    const { error: authError } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    setIsSubmitting(false);

    if (authError) {
      setError(authError.message);
      return;
    }

    router.refresh();
  }

  async function onSignUp() {
    setError(null);
    setNotice(null);
    setIsSubmitting(true);

    const { data, error: authError } = await supabase.auth.signUp({
      email,
      password
    });

    setIsSubmitting(false);

    if (authError) {
      setError(authError.message);
      return;
    }

    if (data.session) {
      router.refresh();
      return;
    }

    setNotice(`Account created for ${email}. Check your inbox if email confirmation is enabled.`);
  }

  async function onResetPassword() {
    setError(null);
    setNotice(null);
    setIsSubmitting(true);

    const redirectTo = `${window.location.origin}/auth/callback?next=/reset-password`;
    const { error: authError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo
    });

    setIsSubmitting(false);

    if (authError) {
      setError(authError.message);
      return;
    }

    setNotice(`Reset link sent to ${email}.`);
  }

  if (user) {
    return (
      <div className="space-y-5">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-smoke">
            Authenticated as
          </p>
          <h2 className="mt-2 font-display text-[1.6rem] font-light leading-tight text-linen">
            {user.email}
          </h2>
          <p className="mt-2 font-mono text-[11px] leading-[1.7] text-fog">
            Your private library is active. Papers and annotations are scoped to this account.
          </p>
        </div>
        <ul className="space-y-1.5 font-mono text-[11px] text-fog">
          <li className="flex gap-2">
            <span className="text-gold/50">›</span> PDF cached by arXiv ID
          </li>
          <li className="flex gap-2">
            <span className="text-gold/50">›</span> Annotations persisted to Supabase
          </li>
          <li className="flex gap-2">
            <span className="text-gold/50">›</span> Chat history preserved per session
          </li>
        </ul>
        <form action="/auth/signout" method="post">
          <button
            className="rounded border border-rim bg-shell px-4 py-2 font-mono text-[11px] uppercase tracking-[0.24em] text-smoke transition hover:border-gold/40 hover:text-linen"
            type="submit"
          >
            Sign out
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-[1.6rem] font-light leading-tight text-linen">
          Sign in required
        </h2>
        <p className="mt-2 font-mono text-[11px] leading-[1.7] text-fog">
          Private paper libraries are tied to your account. Sign in to enable ingestion.
        </p>
      </div>

      <form className="space-y-2" onSubmit={onSignIn}>
        <input
          className="h-10 w-full rounded border border-rim bg-shell/50 px-3 font-mono text-[12px] text-linen outline-none transition placeholder:text-fog focus:border-gold/50 focus:bg-shell"
          type="email"
          placeholder="you@lab.edu"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="h-10 w-full rounded border border-rim bg-shell/50 px-3 font-mono text-[12px] text-linen outline-none transition placeholder:text-fog focus:border-gold/50 focus:bg-shell"
          type="password"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={6}
          required
        />
        <div className="flex gap-2 pt-1">
          <button
            className={cn(
              "h-10 flex-1 rounded bg-gold font-mono text-[11px] uppercase tracking-[0.24em] text-void transition hover:bg-gold/90",
              isSubmitting && "cursor-progress opacity-60"
            )}
            disabled={isSubmitting}
            type="submit"
          >
            {isSubmitting ? "..." : "Sign in"}
          </button>
          <button
            className={cn(
              "h-10 flex-1 rounded border border-rim bg-shell font-mono text-[11px] uppercase tracking-[0.24em] text-linen transition hover:border-gold/40",
              isSubmitting && "cursor-progress opacity-60"
            )}
            disabled={isSubmitting}
            onClick={onSignUp}
            type="button"
          >
            {isSubmitting ? "..." : "Create"}
          </button>
        </div>
        <button
          className="font-mono text-[11px] text-fog underline underline-offset-4 transition hover:text-linen"
          disabled={isSubmitting}
          onClick={onResetPassword}
          type="button"
        >
          Forgot password
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

      <ul className="space-y-1.5 font-mono text-[11px] text-fog">
        <li className="flex gap-2">
          <span className="text-gold/50">›</span> PDF cached by arXiv ID
        </li>
        <li className="flex gap-2">
          <span className="text-gold/50">›</span> Annotations persisted to Supabase
        </li>
        <li className="flex gap-2">
          <span className="text-gold/50">›</span> Chat history preserved per session
        </li>
      </ul>
    </div>
  );
}
