// Used only by the Better Auth CLI to generate the Drizzle auth schema.
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { authOptions } from "./src/auth";
export const auth = betterAuth({
  ...authOptions("http://localhost:5173"),
  database: drizzleAdapter({} as never, { provider: "sqlite" }),
});
