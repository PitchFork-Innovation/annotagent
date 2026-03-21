import { LandingShell } from "@/components/landing-shell";
import { getCurrentUser, getRecentPapers } from "@/lib/server-data";

type Props = {
  searchParams?: {
    auth?: string;
  };
};

export default async function HomePage({ searchParams }: Props) {
  const [user, papers] = await Promise.all([getCurrentUser(), getRecentPapers()]);

  return <LandingShell user={user} papers={papers} hasAuthError={searchParams?.auth === "error"} />;
}
