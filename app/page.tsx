import { LandingShell } from "@/components/landing-shell";
import { getCurrentUser, getRecentPapers } from "@/lib/server-data";

type Props = {
  searchParams?: Promise<{
    auth?: string;
  }>;
};

export default async function HomePage({ searchParams }: Props) {
  const [user, papers] = await Promise.all([getCurrentUser(), getRecentPapers()]);
  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  return <LandingShell user={user} papers={papers} hasAuthError={resolvedSearchParams?.auth === "error"} />;
}
