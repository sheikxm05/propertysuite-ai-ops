import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Entry route.
 *
 * ============================ SEAM FOR LANE w1-l1 ============================
 * w1-l1 replaces this body with a session check and a redirect:
 *   const session = await getSession();
 *   redirect(session ? '/dashboard' : '/sign-in');
 * Until auth exists (Wave 1), this is a static landing page so the app builds and runs.
 * =============================================================================
 */
export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>PropertySuite AI Ops</CardTitle>
          <CardDescription>
            Multi-tenant property operations with AI-assisted maintenance intake and human-verified
            document extraction.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* No link to /dashboard yet: that route is created by lane w1-l1, which also
              replaces this page with a session-aware redirect. Linking to it now would
              be a link to a 404. */}
          <p className="text-sm text-muted-foreground">
            Scaffold is in place. Sign-in and the authenticated dashboard arrive with lane w1-l1.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
