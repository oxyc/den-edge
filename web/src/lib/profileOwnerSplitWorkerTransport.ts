import type { OwnerSplitHouseholdObservation } from './profileOwnerSplitEngine';
import type { OwnerSplitMigrationTransport } from './profileOwnerSplitProvider';
import { OwnerSplitWorkerStore } from './profileOwnerSplitWorkerStore';
import { ownerSplitWorkerRoute } from './profileOwnerSplitRoutes';

const ID = /^[0-9a-f]{32}$/;

export interface OwnerSplitCapability {
  readonly enrollment: 'off' | 'prepare';
  readonly wireMin: number;
  readonly migrationWire: 5;
  readonly runtimeHouseholdWire: 5;
  readonly runtimeProfileWire: 4;
}

/** Implemented by LibraryLog inside the DedicatedWorker. */
export interface OwnerSplitWorkerNetwork {
  readonly libraryId: string;
  profileMigrationRequest(input: {
    readonly method: 'GET' | 'POST' | 'DELETE';
    readonly path: string;
    readonly body?: unknown;
    readonly candidateToken?: string;
  }): Promise<{ readonly status: number; readonly body: unknown }>;
  readProfileMigrationHousehold(
    migrationGeneration: number,
  ): Promise<OwnerSplitHouseholdObservation>;
}

export class OwnerSplitWorkerTransport implements OwnerSplitMigrationTransport {
  readonly #network: OwnerSplitWorkerNetwork;
  readonly #store: OwnerSplitWorkerStore;

  constructor(network: OwnerSplitWorkerNetwork, store: OwnerSplitWorkerStore) {
    if (!ID.test(network.libraryId)) throw new TypeError('Household identity is not canonical');
    this.#network = network;
    this.#store = store;
  }

  async capability(): Promise<OwnerSplitCapability | null> {
    const response = await this.#network.profileMigrationRequest({
      method: 'GET',
      path: `/lib/${this.#network.libraryId}/profile-capability`,
    });
    if (response.status === 404) return null;
    if (response.status !== 200) throw providerError(response.status, response.body);
    return checkedCapability(response.body);
  }

  async request(input: {
    readonly method: 'GET' | 'POST' | 'DELETE';
    readonly path: string;
    readonly body?: unknown;
    readonly candidateKeyRef?: string;
  }): Promise<unknown> {
    const route = ownerSplitWorkerRoute(this.#network.libraryId, input.method, input.path);
    if (route === null || route.kind === 'capability')
      throw new Error('Profile migration method or path is not allowed');
    let candidateToken: string | undefined;
    if (input.candidateKeyRef !== undefined) {
      if (route.kind !== 'retire-candidate')
        throw new Error('Candidate authority is valid only for exact retirement requests');
      candidateToken = (await this.#store.resolveCandidate(input.candidateKeyRef, route.attempt))
        .token;
    } else if (route.kind === 'retire-candidate') {
      throw new Error('Candidate retirement requires Worker-owned authority');
    }
    const response = await this.#network.profileMigrationRequest({
      method: input.method,
      path: input.path,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(candidateToken === undefined ? {} : { candidateToken }),
    });
    if (response.status < 200 || response.status >= 300)
      throw providerError(response.status, response.body);
    return response.body;
  }

  readHousehold(): Promise<OwnerSplitHouseholdObservation> {
    return this.#readHousehold();
  }

  async #readHousehold(): Promise<OwnerSplitHouseholdObservation> {
    const journal = await this.#store.load();
    if (journal?.fence === undefined)
      throw new Error('Fresh household authority requires a durable migration fence');
    return this.#network.readProfileMigrationHousehold(journal.fence.generation);
  }
}

function checkedCapability(value: unknown): OwnerSplitCapability {
  if (
    !record(value) ||
    (value.enrollment !== 'off' && value.enrollment !== 'prepare') ||
    !safePositive(value.wireMin) ||
    value.migrationWire !== 5 ||
    value.runtimeHouseholdWire !== 5 ||
    value.runtimeProfileWire !== 4
  )
    throw new Error('Profile migration capability is malformed');
  return value as unknown as OwnerSplitCapability;
}

function providerError(status: number, body: unknown): Error {
  const code = record(body) && typeof body.error === 'string' ? body.error : 'provider_error';
  return new Error(`Profile migration provider refused ${status} ${code}`);
}

function safePositive(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
