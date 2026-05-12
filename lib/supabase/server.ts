// MIGRATION STUB: Supabase removed. This file preserves the exported API shape
// so callers continue to compile during the Supabase → MongoDB migration.
// Replace call-sites incrementally in Phase 2+.

/* eslint-disable @typescript-eslint/no-explicit-any */

function notImplemented(name: string): Promise<any> {
  return Promise.reject(
    new Error(`${name} is not implemented — Supabase has been removed. Migrate caller to MongoDB/NextAuth.`)
  );
}

function makeDbStub(): any {
  const chain: any = {
    select: (..._args: any[]) => chain,
    insert: (..._args: any[]) => chain,
    update: (..._args: any[]) => chain,
    upsert: (..._args: any[]) => chain,
    delete: (..._args: any[]) => chain,
    eq: (..._args: any[]) => chain,
    neq: (..._args: any[]) => chain,
    single: (..._args: any[]) => notImplemented("db.single"),
    maybeSingle: (..._args: any[]) => notImplemented("db.maybeSingle"),
    limit: (..._args: any[]) => chain,
    order: (..._args: any[]) => chain,
    then: undefined as any,
  };
  return chain;
}

export async function createSupabaseServerClient(): Promise<any> {
  return {
    auth: {
      getUser: (..._args: any[]): Promise<any> =>
        notImplemented("auth.getUser"),
      signOut: (..._args: any[]): Promise<any> =>
        notImplemented("auth.signOut"),
      exchangeCodeForSession: (..._args: any[]): Promise<any> =>
        notImplemented("auth.exchangeCodeForSession"),
    },
    from: (_table: string): any => makeDbStub(),
  };
}
