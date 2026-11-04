export interface Env {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  /** Public origin of this worker, e.g. http://localhost:5173 or https://crm.example.com */
  BETTER_AUTH_URL: string;
  /**
   * Sign-up guard. Comma-separated emails or "@domain" entries ("*" = open sign-up).
   * Unset/empty: only the very first user (bootstrap owner) or someone with a pending invite may sign up.
   */
  ALLOWED_SIGNUP_EMAILS?: string;
}
