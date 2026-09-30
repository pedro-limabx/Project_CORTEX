import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("127.0.0.1"),
  DATABASE_URL: z.string().min(1).optional(),
  LOCAL_TEST_MODE: z.coerce.boolean().default(true),
  LLM_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  CORTEX_API_TOKEN: z.string().min(32).optional(),
  CORTEX_USER_ID: z.string().min(1).default("local-user")
});

export const config = schema.parse(process.env);
