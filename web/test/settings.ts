import { mount } from 'svelte';
import { ensureSyncPolicy } from '../src/lib/syncLoader';
import Fixture from './SettingsFixture.svelte';

await ensureSyncPolicy();
const database = await new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('den-tmdb', 1);
  request.onupgradeneeded = () =>
    request.result.createObjectStore('answers').createIndex('fetchedAt', 'fetchedAt');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
await new Promise<void>((resolve, reject) => {
  const transaction = database.transaction('answers', 'readwrite');
  const answers = transaction.objectStore('answers');
  const detail = (id: number, title: string, releaseDate: string, imdbId: string) =>
    answers.put(
      {
        body: JSON.stringify({ id, title, release_date: releaseDate, imdb_id: imdbId }),
        fetchedAt: Date.now(),
        checked: true,
      },
      `https://api.themoviedb.org/3/movie/${id}?append_to_response=credits`,
    );
  detail(550, 'Fight Club', '1999-10-15', 'tt0137523');
  detail(603, 'The Matrix', '1999-03-31', 'tt0133093');
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error);
});
database.close();
mount(Fixture, { target: document.getElementById('app')! });
