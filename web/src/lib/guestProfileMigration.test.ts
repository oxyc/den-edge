import { describe, expect, it, vi } from 'vitest';
import { migrateGuestProfiles } from './guestProfileMigration';

const source = { generation: 7, head: 'a'.repeat(64) };

describe('legacy guest profile migration', () => {
  it('starts the authenticated in-place split when the guest household is enrolled', async () => {
    const model = {
      profileMigrationStatus: vi.fn(async () => ({
        kind: 'profile-migration.status' as const,
        phase: 'available' as const,
      })),
      observeProfileMigration: vi.fn(async () => ({
        kind: 'profile-migration.observe' as const,
        attempt: '1'.repeat(32),
        source,
      })),
      enableProfiles: vi.fn(async () => ({
        result: { kind: 'profile-migration.enable' as const, outcome: 'enabled' as const },
        affected: [],
      })),
    };

    await expect(migrateGuestProfiles(model as never)).resolves.toBe('enabled');
    expect(model.enableProfiles).toHaveBeenCalledWith('1'.repeat(32), source);
  });

  it('does not attempt a split when the edge does not recognize the household as a guest', async () => {
    const model = {
      profileMigrationStatus: vi.fn(async () => ({
        kind: 'profile-migration.status' as const,
        phase: 'off' as const,
      })),
      observeProfileMigration: vi.fn(),
      enableProfiles: vi.fn(),
    };

    await expect(migrateGuestProfiles(model as never)).resolves.toBe('unavailable');
    expect(model.observeProfileMigration).not.toHaveBeenCalled();
    expect(model.enableProfiles).not.toHaveBeenCalled();
  });

  it('lets status resume a durable attempt without creating a competing one', async () => {
    const model = {
      profileMigrationStatus: vi.fn(async () => ({
        kind: 'profile-migration.status' as const,
        phase: 'reconciling' as const,
      })),
      observeProfileMigration: vi.fn(),
      enableProfiles: vi.fn(),
    };

    await expect(migrateGuestProfiles(model as never)).resolves.toBe('pending');
    expect(model.observeProfileMigration).not.toHaveBeenCalled();
  });
});
