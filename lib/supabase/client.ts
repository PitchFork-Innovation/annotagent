// MIGRATION STUB: Supabase removed. This file preserves the exported API shape
// so callers continue to compile during the Supabase → MongoDB migration.
// Replace call-sites incrementally in Phase 2+.

/* eslint-disable @typescript-eslint/no-explicit-any */

function notImplemented(name: string): Promise<any> {
  return Promise.reject(
    new Error(`${name} is not implemented — Supabase has been removed. Migrate caller to MongoDB/NextAuth.`)
  );
}

export function createSupabaseBrowserClient(): any {
  return {
    auth: {
      getUser: (..._args: any[]): Promise<any> =>
        notImplemented("auth.getUser"),
      signOut: (..._args: any[]): Promise<any> =>
        notImplemented("auth.signOut"),
      signInWithPassword: (..._args: any[]): Promise<any> =>
        notImplemented("auth.signInWithPassword"),
      signUp: (..._args: any[]): Promise<any> =>
        notImplemented("auth.signUp"),
      resetPasswordForEmail: (..._args: any[]): Promise<any> =>
        notImplemented("auth.resetPasswordForEmail"),
      updateUser: (..._args: any[]): Promise<any> =>
        notImplemented("auth.updateUser"),
      onAuthStateChange: (..._args: any[]) => ({
        data: { subscription: { unsubscribe: () => notImplemented("auth.onAuthStateChange.unsubscribe") } }
      }),
    },
    from: (_table: string): any => {
      const chain: any = {
        select: (..._args: any[]) => chain,
        eq: (..._args: any[]) => chain,
        limit: (..._args: any[]) => chain,
        maybeSingle: (..._args: any[]) => notImplemented("db.maybeSingle"),
        then: undefined as any,
      };
      return chain;
    },
  };
}
