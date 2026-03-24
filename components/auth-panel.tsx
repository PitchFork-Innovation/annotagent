"use client";

import { FormEvent, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { UserProfile } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  user: UserProfile | null;
  hasAuthError?: boolean;
};

export function AuthPanel({ user, hasAuthError = false }: Props) {
  const [supabase] = useState(() => createSupabaseBrowserClient());
  const [email, setEmail] = useState(user?.email ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(
    hasAuthError ? "That sign-in link was invalid or expired. Request a fresh one below." : null
  );
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setIsSubmitting(true);

    const redirectTo = `${window.location.origin}/auth/callback?next=/`;
    const { error: authError } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: redirectTo
      }
    });

    setIsSubmitting(false);

    if (authError) {
      setError(authError.message);
      return;
    }

    setNotice(`Magic link sent to ${email}. Open it on this device to unlock your private paper library.`);
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
          We require private per-user paper libraries via Supabase Auth. Use an email magic link to unlock
          ingestion and your saved library.
        </p>
      </div>
      <form className="space-y-3" onSubmit={onSubmit}>
        <input
          className="h-12 w-full rounded-2xl border border-white/10 bg-white/10 px-4 text-sm text-white outline-none transition placeholder:text-white/35 focus:border-white/30"
          type="email"
          placeholder="you@lab.edu"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
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
          {isSubmitting ? "Sending magic link..." : "Email me a sign-in link"}
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
