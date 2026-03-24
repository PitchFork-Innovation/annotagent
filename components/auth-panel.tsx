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
    hasAuthError ? "Authentication could not be completed. Try signing in again below." : null
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

    setNotice(`Account created for ${email}. Check your inbox if email confirmation is enabled in Supabase.`);
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

    setNotice(`Password reset email sent to ${email}. Use the link in that email to set a password.`);
  }

  if (user) {
    return (
      <div className="mt-4 space-y-4">
        <div>
          <h2 className="text-2xl font-semibold">{user.email}</h2>
          <p className="mt-2 text-sm leading-6 text-white/70">
            Your private library is active. New papers and annotations will be scoped to this Supabase account.
          </p>
        </div>
        <ul className="space-y-3 text-sm text-white/80">
          <li>PDF cached by arXiv ID in Supabase Storage</li>
          <li>Annotations persisted with page and normalized bounding boxes</li>
          <li>24-hour inquiry history kept in KV-compatible session storage</li>
        </ul>
        <form action="/auth/signout" method="post">
          <button
            className="inline-flex h-11 items-center rounded-2xl border border-white/15 bg-white/10 px-4 text-sm font-semibold text-white transition hover:bg-white/15"
            type="submit"
          >
            Sign out
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">Sign in required</h2>
        <p className="mt-2 text-sm leading-6 text-white/70">
          We require private per-user paper libraries via Supabase Auth. Sign in with your email and password
          to unlock ingestion and your saved library.
        </p>
      </div>
      <form className="space-y-3" onSubmit={onSignIn}>
        <input
          className="h-12 w-full rounded-2xl border border-white/10 bg-white/10 px-4 text-sm text-white outline-none transition placeholder:text-white/35 focus:border-white/30"
          type="email"
          placeholder="you@lab.edu"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <input
          className="h-12 w-full rounded-2xl border border-white/10 bg-white/10 px-4 text-sm text-white outline-none transition placeholder:text-white/35 focus:border-white/30"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          minLength={6}
          required
        />
        <button
          className={cn(
            "inline-flex h-12 w-full items-center justify-center rounded-2xl bg-coral px-4 text-sm font-semibold text-night transition hover:bg-coral/90",
            isSubmitting && "cursor-progress opacity-70"
          )}
          disabled={isSubmitting}
          type="submit"
        >
          {isSubmitting ? "Signing in..." : "Sign in"}
        </button>
        <button
          className={cn(
            "inline-flex h-12 w-full items-center justify-center rounded-2xl border border-white/15 bg-white/10 px-4 text-sm font-semibold text-white transition hover:bg-white/15",
            isSubmitting && "cursor-progress opacity-70"
          )}
          disabled={isSubmitting}
          onClick={onSignUp}
          type="button"
        >
          {isSubmitting ? "Creating account..." : "Create account"}
        </button>
        <button
          className="text-sm text-white/75 underline underline-offset-4 transition hover:text-white"
          disabled={isSubmitting}
          onClick={onResetPassword}
          type="button"
        >
          Forgot password?
        </button>
      </form>
      {error ? <p className="text-sm text-red-300">{error}</p> : null}
      {notice ? <p className="text-sm text-emerald-200">{notice}</p> : null}
      <ul className="space-y-3 text-sm text-white/80">
        <li>PDF cached by arXiv ID in Supabase Storage</li>
        <li>Annotations persisted with page and normalized bounding boxes</li>
        <li>24-hour inquiry history kept in KV-compatible session storage</li>
      </ul>
    </div>
  );
}
