export interface ProfilePinInput {
  readonly value: string;
  readonly complete: boolean;
}

/** Keep profile PIN entry numeric and bounded before deciding whether its fourth digit submits. */
export function profilePinInput(raw: string): ProfilePinInput {
  const value = raw.replace(/\D/g, '').slice(0, 4);
  return { value, complete: value.length === 4 };
}
