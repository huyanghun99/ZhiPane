import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(39280),
  APP_SECRET: z.string().min(16).default('development-secret-change-me-now'),
  PUBLIC_BASE_URL: z.string().default('http://127.0.0.1:39280'),
  WEB_ORIGINS: z.string().optional().default(''),
  ALLOW_SIGNUP: z.coerce.boolean().default(true),
  DATABASE_URL: z.string().default('postgres://zhipane:zhipane@127.0.0.1:5432/zhipane'),
  EMBEDDING_DIMENSION: z.coerce.number().int().positive().default(1536),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  UPLOAD_DIR: z.string().default('./data/uploads'),
  AI_DRIVER: z.enum(['mock', 'openai', 'openai-compatible', 'ollama', 'gemini']).default('mock'),
  AI_COMPLETION_MODEL: z.string().default('mock-chat'),
  AI_EMBEDDING_MODEL: z.string().default('mock-embedding'),
  EMBEDDING_BASE_URL: z.string().optional().default(''),
  EMBEDDING_API_KEY: z.string().optional().default(''),
  OPENAI_API_URL: z.string().default('https://api.openai.com/v1'),
  OPENAI_API_KEY: z.string().optional().default(''),
  RAG_RATE_LIMIT_PER_USER_PER_MINUTE: z.coerce.number().int().positive().default(20),
  RAG_RATE_LIMIT_PER_SPACE_PER_MINUTE: z.coerce.number().int().positive().default(60)
});

export const env = envSchema.parse(process.env);
