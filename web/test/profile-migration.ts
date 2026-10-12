import {
  ProfileMigrationParticipant,
  type ProfileMigrationDecision,
  type ProfileMigrationExecutor,
  type ProfileMigrationJournal,
  type ProfilesDirectory,
} from '../src/lib/profileMigration';

const OWNER = '00112233445566778899aabbccddeeff';
const calls: string[] = [];
const directory = (ownerKey: string) =>
  ({
    format: 4,
    kind: 'profiles',
    schema: 1,
    owner: OWNER,
    migration: {},
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
    return { generation: 'fixture-generation', base: 9, rewrite: 'fixture-rewrite' };
  },
  createAndVerifyBackup: async () => {
    calls.push('backup');
    return { id: 'fixture-backup', digest: 'fixture-backup-digest' };
  },
  createOwnerCandidate: async () => {
    calls.push('candidate');
    return { profileId: OWNER, libraryId: 'candidate-id', libraryKey: 'candidate-key' };
  },
  copyOwnerPartition: async () => void calls.push('copy'),
  verifyOwnerLibrary: async () => {
    calls.push('verify-owner');
    return { head: 'fixture-owner-head' };
  },
  prepareHouseholdRewrite: async () => {
    calls.push('prepare');
    return { digest: 'fixture-prepared-digest' };
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
  householdId: 'fixture-household-id',
  householdLibraryKey: 'fixture-household-key',
  storage: localStorage,
  executor,
  planner,
  validateDirectory: (value) => value,
  randomAttempt: () => '0123456789abcdef0123456789abcdef',
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
  localStorage.setItem('fixture.profileMigration.winner', 'winner-key');
});
document.querySelector('#candidate-winner')!.addEventListener('click', () => {
  localStorage.setItem('fixture.profileMigration.winner', 'candidate-key');
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
