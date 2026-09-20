import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable(
  "users",
  {
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
    username: text("username").notNull().unique(),
    password: text("password").notNull(),
    role: text("role").notNull().default("user"),
  },
  (table) => [
    uniqueIndex("users_username_nocase").on(sql`lower(${table.username})`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),

    userId: integer("user_id")
      .notNull()
      .references(() => users.id),

    organization: text("organization"),

    startTime: timestamp("start_time", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),

    endTime: timestamp("end_time", {
      withTimezone: true,
      mode: "string",
    }),

    lastUpdate: timestamp("last_update", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),

    status: text("status").notNull().default("active"),
  },
  (table) => [
    uniqueIndex("sessions_one_active_per_user")
      .on(table.userId)
      .where(sql`${table.status} = 'active'`),

    index("sessions_start_time_idx").on(table.startTime),

    index("sessions_user_status_idx").on(
      table.userId,
      table.status,
    ),
  ],
);

export const counts = pgTable(
  "counts",
  {
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),

    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id),

    code: text("code").notNull(),

    quantity: integer("quantity").notNull().default(0),
  },
  (table) => [
    uniqueIndex("counts_session_code_unique").on(
      table.sessionId,
      table.code,
    ),

    index("counts_session_id_idx").on(table.sessionId),
  ],
);

export const itens = pgTable(
  "itens",
  {
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),

    codigo: text("codigo").notNull().unique(),

    quantidade: integer("quantidade").notNull().default(0),
  },
);
