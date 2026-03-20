import { LandingShell } from "@/components/landing-shell";
import { getCurrentUser, getRecentPapers } from "@/lib/server-data";

export default async function HomePage() {
  const [user, papers] = await Promise.all([getCurrentUser(), getRecentPapers()]);

  return <LandingShell user={user} papers={papers} />;
}
