import bcrypt from "bcryptjs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { inArray, sql } from "drizzle-orm";
import { users } from "@workspace/db/schema";

const rawUsernames = (process.env.TEMP_PASSWORD_USERS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const tempPassword = process.env.TEMP_PASSWORD_DEFAULT;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for this one-off reset script.");
}

if (rawUsernames.length === 0) {
  throw new Error("Set TEMP_PASSWORD_USERS to the comma-separated usernames that must be forced to change their password.");
}

if (!tempPassword || tempPassword.trim().length === 0) {
  throw new Error("TEMP_PASSWORD_DEFAULT is required and cannot be empty.");
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const db = drizzle(client);

  const existingUsers = await db.select({ username: users.username })
    .from(users)
    .where(inArray(users.username, rawUsernames));

  const existingUsernames = new Set(existingUsers.map((user) => user.username));
  const missingUsernames = rawUsernames.filter((username) => !existingUsernames.has(username));

  if (missingUsernames.length > 0) {
    throw new Error(`Cannot reset temporary password: missing users: ${missingUsernames.join(", ")}`);
  }

  const passwordHash = await bcrypt.hash(tempPassword, 10);

  const result = await db.update(users)
    .set({
      password: passwordHash,
      mustChangePassword: true,
      authVersion: sql`${users.authVersion} + 1`,
    })
    .where(inArray(users.username, rawUsernames))
    .returning({ username: users.username });

  console.log(`Updated ${result.length} user(s) with a temporary password and must_change_password=true.`);
  console.log(`Usernames: ${result.map((row) => row.username).join(", ") || "none"}`);
} finally {
  await client.end();
}
