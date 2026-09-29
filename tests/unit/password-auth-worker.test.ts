/**
 * Password sign-in, change and temporary passwords do not exist on a Worker.
 *
 * The stored hashes are Argon2id and workerd cannot compute Argon2id, so on a Worker every one of
 * these flows is refused up front with a deliberate 403 — before a rate-limit counter or a user
 * lookup. Found in the Worker preview: without Access configured, an unknown address answered
 * 500 (the timing-equalisation hash threw) and a known one "incorrect password", which is what
 * the right password would have got too.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setRuntimeOverride } from '@/server/runtime';
import { ForbiddenError } from '@/server/errors/app-error';
import { isPasswordAuthAvailable } from '@/server/auth/access-session';
import * as rateLimit from '@/server/auth/rate-limit';
import * as userRepository from '@/server/repositories/user.repository';
import { authService } from '@/server/services/auth.service';
import { TEST_META } from '../helpers/fixtures';

afterEach(() => {
  setRuntimeOverride(null);
  vi.restoreAllMocks();
});

describe('password authentication on a Worker', () => {
  it('is not available', () => {
    setRuntimeOverride('workerd');
    expect(isPasswordAuthAvailable()).toBe(false);
  });

  it('refuses sign-in with the single-sign-on message, before any counter or lookup', async () => {
    setRuntimeOverride('workerd');
    const enforce = vi.spyOn(rateLimit, 'enforce');
    const lookup = vi.spyOn(userRepository, 'findByEmailWithSecrets');

    const attempt = authService.loginWithPassword(
      { email: 'nobody@company.com', password: 'Irrelevant-Pass!2026' },
      TEST_META,
    );
    await expect(attempt).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      authService.loginWithPassword({ email: 'nobody@company.com', password: 'x' }, TEST_META),
    ).rejects.toThrow(/single sign-on/);
    expect(enforce).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses a password change before loading the account', async () => {
    setRuntimeOverride('workerd');
    const lookup = vi.spyOn(userRepository, 'findById');
    await expect(
      authService.changePassword(
        { userId: 'u1', currentPassword: 'a', newPassword: 'Irrelevant-Pass!2026', sessionId: 's1' },
        TEST_META,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('password authentication on the Node deployment without Access', () => {
  it('remains available', () => {
    setRuntimeOverride('node');
    expect(isPasswordAuthAvailable()).toBe(true);
  });
});
