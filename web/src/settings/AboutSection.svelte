<!-- Settings › About, as on the TV: the Terms of Use, the version, and the credits the data's terms ask for — Den's own
     sources first, then each addon's, as its manifest names them (den-spec attribution-v1). -->
<script lang="ts">
  import SettingRow from './SettingRow.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import { linkParts, type Credit } from './credits';
  import tmdbLogo from '../assets/tmdb-logo.svg';

  let {
    edgeVersion,
    credits,
    hasOmdbKey,
  }: {
    edgeVersion: string | null;
    /** What the installed addons credit, in their order. */
    credits: readonly Credit[];
    hasOmdbKey: boolean;
  } = $props();

  /** `TermsView`, word for word. */
  const TERMS = [
    [
      'Den is a neutral media player.',
      'Den plays your own media servers (Jellyfin / Plex) and discovers titles via TMDB. It ships no content and no sources of its own.',
    ],
    [
      'Addons are user-added.',
      'Den implements a neutral addon protocol. It bundles, presets, and recommends no addons. Any addon is one you add yourself by entering its URL.',
    ],
    [
      'Den does not review or endorse addons.',
      'Addons are third-party services Den neither operates nor vets. Den simply plays a stream URL that a user-added addon returns.',
    ],
    [
      'Addon developers and users are responsible for content.',
      'Addons must not facilitate access to content you are not authorized to access. You are responsible for ensuring your use complies with applicable law and the rights of content owners.',
    ],
  ];

  /**
   * The sources Den calls itself, while it does: a key set here is a source it's using. Content warnings are
   * credited whatever the keys say, since den-edge serves the ones it keeps to every browser — in the wording
   * doesthedogdie's API terms require (§6).
   */
  const own = $derived<Credit[]>([
    ...(hasOmdbKey
      ? [{ text: 'Ratings by OMDb.', link: 'OMDb', url: 'https://www.omdbapi.com' }]
      : []),
    {
      text: 'Content warnings: Powered by DoesTheDogDie.com',
      link: 'Powered by DoesTheDogDie.com',
      url: 'https://www.doesthedogdie.com',
    },
  ]);
</script>

<SettingsSection id="about" title="About">
  <SettingRow id="terms" label="Terms of Use">
    {#each TERMS as [heading, body] (heading)}
      <h3>{heading}</h3>
      <p class="term">{body}</p>
    {/each}
  </SettingRow>
  <SettingRow id="version" label="Version" value={edgeVersion ? `den-edge ${edgeVersion}` : ''} />
</SettingsSection>

<!-- TMDB's terms require its credit and logo wherever its data is shown; every other source's statement is as its
     addon words it, shown as text. -->
<div class="credits">
  <a
    class="tmdb"
    href="https://www.themoviedb.org"
    target="_blank"
    rel="noreferrer noopener"
    aria-label="The Movie Database (TMDB)"
  >
    <img src={tmdbLogo} alt="" width="170" height="14" />
  </a>
  <p>
    This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved
    by TMDB. <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer noopener"
      >themoviedb.org</a
    >
  </p>
  {#each [...own, ...credits] as credit (credit.text)}
    {@const parts = linkParts(credit)}
    <p>
      {#if parts}{parts.before}<a href={credit.url} target="_blank" rel="noreferrer noopener"
          >{parts.link}</a
        >{parts.after}{:else}{credit.text}{/if}
    </p>
  {/each}
</div>

<style>
  h3 {
    margin: 16px 0 4px;
    font-size: 15px;
  }

  .term {
    margin: 0;
    color: var(--muted);
    font-size: 14px;
  }

  .credits {
    margin: -24px 16px 40px;
    color: var(--muted);
    font-size: 13px;
  }

  .credits p {
    margin: 0 0 10px;
  }

  /* TMDB's logo, as its terms ask for beside the credit, at the height the TV app draws it relative to its text. */
  .tmdb {
    display: inline-block;
    margin: 6px 0 10px;
  }

  .tmdb img {
    display: block;
    block-size: 14px;
    inline-size: auto;
  }
</style>
