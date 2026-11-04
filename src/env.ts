export interface Env {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  /** Public origin of this worker, e.g. http://localhost:5173 or https://crm.example.com */
  BETTER_AUTH_URL: string;
}
