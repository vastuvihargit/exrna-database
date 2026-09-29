/**
 * The application's own password reset exists on the legacy Node deployment only.
 *
 * Behind Cloudflare Access, and on any Worker, both halves of the flow are refused up front with
 * a message that sends the user to the identity provider — before a rate-limit counter, a user
 * lookup or the MongoDB token collection is touched. On a Worker the last of those is the point:
 * Mongoose cannot run there, and the failure must be a deliberate 403, not a 500.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { setRuntimeOverride } from '@/server/runtime';
import { ForbiddenError } from '@/server/errors/app-error';
import { isPasswordRecoveryAvailable } from '@/server/auth/access-session';
import { authService } from '@/server/services/auth.service';
import { PasswordResetTokenModel } from '@/server/db/models';
import { TEST_META } from '../helpers/fixtures';

afterEach(() => {
  setRuntimeOverride(null);
  vi.restoreAllMocks();
});

describe('password recovery on a Worker', () => {
  it('is not available', () => {
    setRuntimeOverride('workerd');
    expect(isPasswordRecoveryAvailable()).toBe(false);
  });

  it('refuses a reset request with the identity-provider message, touching nothing', async () => {
    setRuntimeOverride('workerd');
    const connect = vi.spyOn(mongoose, 'connect');
    const create = vi.spyOn(PasswordResetTokenModel, 'create');

    const attempt = authService.requestPasswordReset('alice@company.com', TEST_META);
    await expect(attempt).rejects.toBeInstanceOf(ForbiddenError);
    await expect(authService.requestPasswordReset('alice@company.com', TEST_META)).rejects.toThrow(
      /identity provider/,
    );
    expect(connect).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses to complete a reset, touching nothing', async () => {
    setRuntimeOverride('workerd');
    const findOne = vi.spyOn(PasswordResetTokenModel, 'findOne');
    await expect(
      authService.completePasswordReset({ token: 'x'.repeat(43), password: 'Irrelevant-Pass!2026' }, TEST_META),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(findOne).not.toHaveBeenCalled();
  });
});

describe('password recovery on the Node deployment without Access', () => {
  it('remains available', () => {
    setRuntimeOverride('node');
    expect(isPasswordRecoveryAvailable()).toBe(true);
  });
});
