import {
  ProfileMigrationParticipant,
  type ProfileMigrationDecision,
  type ProfileMigrationExecutor,
  type ProfileMigrationJournal,
  type ProfilesDirectory,
} from '../src/lib/profileMigration';

const OWNER = '00112233445566778899aabbccddeeff';
const ATTEMPT = '0123456789abcdef0123456789abcdef';
const HOUSEHOLD_ID = 'ffeeddccbbaa00998877665544332211';
const CANDIDATE_ID = '11223344556677889900aabbccddeeff';
const key = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
const HOUSEHOLD_KEY = key(1);
const CANDIDATE_KEY = key(2);
const WINNER_KEY = key(3);
const SOURCE_HEAD = 'a'.repeat(64);
const BACKUP_DIGEST = 'b'.repeat(64);
const OWNER_HEAD = 'c'.repeat(64);
const PREPARED_DIGEST = 'd'.repeat(64);
const calls: string[] = [];
const directory = (ownerKey: string) =>
  ({
    format: 4,
    kind: 'profiles',
    schema: 1,
    owner: OWNER,
    migration: { attempt: ATTEMPT },
    profiles: {
      [OWNER]: {
        library: { value: { key: ownerKey } },
        deleted: { value: false },
      },
    },
  }) as ProfilesDirectory;

const executor: ProfileMigrationExecutor = {
  observe: async () => {
    const winner = localStorage.getItem('fixture.profileMigration.winner');
    return winner
      ? { kind: 'committed', directory: directory(winner) }
      : { kind: 'legacy', fence: 'same' };
  },
  acquireFence: async () => {
    calls.push('fence');
    return { generation: 7, head: SOURCE_HEAD, base: 9, rewrite: 'fixture-rewrite' };
  },
  createAndVerifyBackup: async () => {
    calls.push('backup');
    return { id: 'fixture-backup', digest: BACKUP_DIGEST };
  },
  createOwnerCandidate: async () => {
    calls.push('candidate');
    return { profileId: OWNER, libraryId: CANDIDATE_ID, libraryKey: CANDIDATE_KEY };
  },
  copyOwnerPartition: async () => void calls.push('copy'),
  verifyOwnerLibrary: async () => {
    calls.push('verify-owner');
    return { head: OWNER_HEAD };
  },
  prepareHouseholdRewrite: async () => {
    calls.push('prepare');
    return { digest: PREPARED_DIGEST };
  },
  verifyWinner: async () => {
    calls.push('verify-winner');
    return true;
  },
  adoptWinner: async () => void calls.push('adopt'),
  retireLosingCandidate: async () => {
    calls.push('retire');
    return 'retired';
  },
};

const planner = (input: Record<string, unknown>): ProfileMigrationDecision => {
  if (input.observed === 'committed') {
    if (
      input.candidateLibrary &&
      input.candidateLibrary !== input.winnerLibrary &&
      !input.candidateRetired
    )
      return 'retire-losing-candidate';
    if (!input.winnerVerified) return 'verify-winner';
    return 'activate';
  }
  const next: Record<string, ProfileMigrationDecision> = {
    idle: 'acquire-fence',
    fenced: 'create-backup',
    'backed-up': 'create-owner-library',
    'owner-copied': 'verify-owner-library',
    'ready-to-commit': 'commit-fenced-household',
  };
  const decision = next[input.state as string];
  if (!decision) throw new Error('unexpected fixture state');
  return decision;
};

const participant = new ProfileMigrationParticipant({
  householdId: HOUSEHOLD_ID,
  householdLibraryKey: HOUSEHOLD_KEY,
  storage: localStorage,
  executor,
  planner,
  validateDirectory: (value) => value,
  randomAttempt: () => ATTEMPT,
});

let status = participant.journal ? 'recoverable' : 'inactive';
const output = document.querySelector<HTMLOutputElement>('#status')!;
const render = () => (output.value = status);
render();

document.querySelector('#begin')!.addEventListener('click', () => {
  participant.beginExplicitOwnerAction(true);
  status = 'idle';
  render();
});
document.querySelector('#advance')!.addEventListener('click', () => {
  void participant.resume().then((next) => {
    status = next.kind === 'progress' ? next.state : next.kind;
    render();
  });
});
document.querySelector('#winner')!.addEventListener('click', () => {
  localStorage.setItem('fixture.profileMigration.winner', WINNER_KEY);
});
document.querySelector('#candidate-winner')!.addEventListener('click', () => {
  localStorage.setItem('fixture.profileMigration.winner', CANDIDATE_KEY);
});

declare global {
  interface Window {
    denProfileMigrationFixture: {
      snapshot(): {
        calls: string[];
        journal: ProfileMigrationJournal | null;
        status: string;
      };
    };
  }
}

window.denProfileMigrationFixture = {
  snapshot: () => ({ calls: [...calls], journal: participant.journal, status }),
};
