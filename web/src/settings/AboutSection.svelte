<!-- Settings › About, as on the TV: the Terms of Use, the version, and the credits the data's terms ask for. -->
<script lang="ts">
  import SettingRow from './SettingRow.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import tmdbLogo from '../assets/tmdb-logo.svg';

  let { edgeVersion }: { edgeVersion: string | null } = $props();

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

<!-- TMDB's terms require the credit wherever its data is shown, and Movie of the Night's (TERMS.md §4) ask for its
     statement and link wherever its data reaches users: den-atlas leads each service's rows, and ranks the billboard,
     with it. -->
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
  <p>
    Discovery data (subgenres, moods, and “more like this”) is derived from Wikipedia article text,
    used under
    <a
      href="https://creativecommons.org/licenses/by-sa/4.0"
      target="_blank"
      rel="noreferrer noopener">CC BY-SA 4.0</a
    >
    and modified. Ratings by OMDb. Streaming availability information is provided by
    <a href="https://www.movieofthenight.com/about/api" target="_blank" rel="noreferrer noopener"
      >Streaming Availability API by Movie of the Night</a
    >
    and by JustWatch. Collaborative data by Trakt when connected.
  </p>
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
