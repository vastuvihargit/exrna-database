/**
 * Input schemas for the authentication endpoints.
 *
 * Every schema is `.strict()`: an unexpected field is a 422, not something silently
 * dropped. That is what stops mass-assignment (`{"isSuperAdmin": true}`) at the door.
 *
 * Types are coerced with `z.string()` before anything touches a query, which is also
 * what defeats NoSQL injection payloads like `{"email": {"$ne": null}}` — an object
 * simply is not a string.
 */
import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/server/auth/password';

export const loginSchema = z
  .object({
    email: z.string().min(3).max(320),
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  })
  .strict();

export const forgotPasswordSchema = z
  .object({
    email: z.string().min(3).max(320),
  })
  .strict();

export const resetPasswordSchema = z
  .object({
    token: z.string().min(20).max(200),
    password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
