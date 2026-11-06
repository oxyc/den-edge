export type RecoveryConfirmationOutcome =
  | { state: 'committed' }
  | { state: 'pending' }
  | { state: 'lost' }
  | { state: 'authority-replaced' };

export type RecoveryAbandonOutcome = RecoveryConfirmationOutcome | { state: 'abandoned' };
