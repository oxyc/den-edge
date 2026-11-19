interface MaterializedPosterPage {
  locator(
    selector: string,
    options: { hasText: string },
  ): {
    waitFor(options: { state: 'visible'; timeout: number }): Promise<void>;
  };
}

/** Wait until a windowed poster's real card has replaced its light navigation proxy. */
export async function waitForMaterializedPoster(
  page: MaterializedPosterPage,
  title: string,
  timeout = 20_000,
): Promise<void> {
  await page.locator('.card', { hasText: title }).waitFor({ state: 'visible', timeout });
}
