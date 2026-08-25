import "dotenv/config";

/**
 * Points the integration suite at the test branch, and refuses to run without one.
 *
 * The suites clean up in `afterAll`, which does not run when a run is interrupted — 110 users, 90
 * chats and 238 ledger rows accumulated in production that way. A separate branch makes the leak
 * harmless; throwing when it is unset is what makes the separation hold, because a missing env var
 * would otherwise silently fall back to whatever `DATABASE_URL` happens to be.
 */
function requireTestDatabase(): void {
  const test = process.env.TEST_DATABASE_URL;

  if (!test) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Integration tests write real rows and must not run against " +
        "the production branch — point it at the Neon `dev` branch.",
    );
  }

  const host = (url: string) => {
    try {
      return new URL(url).hostname.replace("-pooler", "");
    } catch {
      return url;
    }
  };

  if (process.env.DATABASE_URL && host(process.env.DATABASE_URL) === host(test)) {
    return;
  }

  process.env.DATABASE_URL = test;
  if (process.env.TEST_DATABASE_URL_UNPOOLED) {
    process.env.DATABASE_URL_UNPOOLED = process.env.TEST_DATABASE_URL_UNPOOLED;
  }
}

requireTestDatabase();
