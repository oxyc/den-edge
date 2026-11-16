export interface MutationClaim<Authority extends object, Intent> {
  readonly authority: Authority;
  readonly intent: Intent;
  readonly generation: number;
}

/**
 * Owns presentation state for one latest settings mutation. The durable writer remains authoritative; this only
 * prevents an older completion, a replaced authority, or an unmounted screen from publishing UI state.
 */
export class LatestMutation<Authority extends object, Intent> {
  #generation = 0;

  begin(authority: Authority, intent: Intent): MutationClaim<Authority, Intent> {
    return { authority, intent, generation: ++this.#generation };
  }

  isCurrent(claim: MutationClaim<Authority, Intent>, authority: Authority): boolean {
    return claim.authority === authority && claim.generation === this.#generation;
  }

  retire(): void {
    this.#generation++;
  }
}
