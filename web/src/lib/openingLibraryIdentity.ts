import { knownProfileHousehold } from './profileHouseholdHint';
import type { LibraryServiceHello } from './libraryServiceProtocol';

type OpeningLibraryIdentity = Pick<LibraryServiceHello, 'libraryKey' | 'mode' | 'wire'>;
const LIBRARY_KEY = /^[A-Za-z0-9+/]{43}=$/;
const ID = /^[0-9a-f]{32}$/;

function linkedLibrary(value: unknown): string | null {
  const link = value as {
    inboxKey?: unknown;
    libraryKey?: unknown;
    linkKey?: unknown;
    deviceId?: unknown;
    sentIdentityName?: unknown;
    sentIdentityDeviceId?: unknown;
  } | null;
  return link &&
    typeof link.inboxKey === 'string' &&
    /^[0-9a-f]{16,}$/i.test(link.inboxKey) &&
    typeof link.libraryKey === 'string' &&
    LIBRARY_KEY.test(link.libraryKey) &&
    typeof link.linkKey === 'string' &&
    (link.deviceId === undefined || /^[0-9a-f]{16}$/.test(String(link.deviceId))) &&
    (link.sentIdentityName === undefined || typeof link.sentIdentityName === 'string') &&
    (link.sentIdentityDeviceId === undefined ||
      /^[0-9a-f]{16}$/.test(String(link.sentIdentityDeviceId)))
    ? link.libraryKey
    : null;
}

function householdPlan(value: unknown): {
  householdKey: string;
  stagingKey: string;
  verified?: { household: number; owner: number };
} | null {
  const plan = value as {
    version?: unknown;
    stagingKey?: unknown;
    householdKey?: unknown;
    attempt?: unknown;
    ownerProfile?: unknown;
    ownerKey?: unknown;
    createdAt?: unknown;
    started?: unknown;
    verified?: { household?: unknown; owner?: unknown };
  } | null;
  if (
    !plan ||
    plan.version !== 1 ||
    typeof plan.stagingKey !== 'string' ||
    !LIBRARY_KEY.test(plan.stagingKey) ||
    typeof plan.householdKey !== 'string' ||
    !LIBRARY_KEY.test(plan.householdKey) ||
    typeof plan.ownerKey !== 'string' ||
    !LIBRARY_KEY.test(plan.ownerKey) ||
    typeof plan.attempt !== 'string' ||
    !ID.test(plan.attempt) ||
    typeof plan.ownerProfile !== 'string' ||
    !ID.test(plan.ownerProfile) ||
    !Number.isSafeInteger(plan.createdAt) ||
    typeof plan.started !== 'boolean' ||
    (plan.verified !== undefined &&
      (!Number.isSafeInteger(plan.verified.household) ||
        !Number.isSafeInteger(plan.verified.owner)))
  )
    return null;
  return plan as {
    householdKey: string;
    stagingKey: string;
    verified?: { household: number; owner: number };
  };
}

/**
 * The exact primary authority this load will open, when storage already establishes one. This desktop-only module
 * starts that SharedWorker realm beside the app module; first-time/public browsing waits for RoutedLibrary to decide.
 */
export function openingLibraryIdentity(
  storage: Storage = localStorage,
): OpeningLibraryIdentity | null {
  try {
    const links: unknown = JSON.parse(storage.getItem('den.links') ?? '[]');
    const linkedKey = Array.isArray(links)
      ? links.map(linkedLibrary).find((key): key is string => key !== null)
      : undefined;
    if (linkedKey) {
      return {
        libraryKey: linkedKey,
        mode: 'online',
        wire: knownProfileHousehold(linkedKey, storage) ? 5 : 4,
      };
    }

    const local = storage.getItem('den.localLibrary');
    const localKey = local && LIBRARY_KEY.test(local) ? local : null;
    const household = storage.getItem('den.household');
    const householdKey = household && LIBRARY_KEY.test(household) ? household : null;
    const plan = householdPlan(JSON.parse(storage.getItem('den.household.plan') ?? 'null'));
    const plannedForHousehold =
      plan &&
      plan.householdKey === householdKey &&
      (plan.stagingKey !== localKey || plan.verified !== undefined);
    const libraryKey = plannedForHousehold ? householdKey : plan ? null : householdKey;
    if (libraryKey)
      return {
        libraryKey,
        mode: 'online',
        wire: knownProfileHousehold(libraryKey, storage) ? 5 : 4,
      };
    return localKey ? { libraryKey: localKey, mode: 'local', wire: 4 } : null;
  } catch {
    return null;
  }
}
