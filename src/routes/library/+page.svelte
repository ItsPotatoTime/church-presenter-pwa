<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { base } from '$app/paths';
  import { sortBibleVerses } from '$lib/bible';
  import { loadCredentials } from '$lib/db';
  import type { BibleBook, BibleVerse, LibrarySong } from '$lib/protocol';
  import { normalize, renderMarkdown } from '$lib/search';
  import { isReducedDataConnection, syncFull, syncNow } from '$lib/sync';
  import {
    bibleBooksStore,
    bibleVersesStore,
    connStatus,
    isViewOnly,
    songsStore,
    syncStatus,
    canEditKeys,
  } from '$lib/stores';
  import { remote } from '$lib/ws';
  import ProjectorOverlay from '$lib/ProjectorOverlay.svelte';

  type LibraryMode = 'songs' | 'bible' | 'write_song';
  type BibleSearchMode = 'reference' | 'text';
  type BibleReferenceParse = {
    exactBook: BibleBook | null;
    bookMatches: BibleBook[];
    chapter: number | null;
    verse: number | null;
  };

  let rawQuery = $state('');
  let query = $state('');
  let searchSlides = $state(false);
  let previewSong = $state<LibrarySong | null>(null);
  let showProjector = $state(false);
  let debounceTimer: number | null = null;
  let renderCount = $state(300);
  let sentinel = $state<Element | null>(null);

  const libraryMode = $derived(($page.url.searchParams.get('mode') as LibraryMode) || 'songs');
  let rawBibleQuery = $state('');
  let bibleQuery = $state('');
  let bibleSearchMode = $state<BibleSearchMode>('reference');
  let bibleDebounceTimer: number | null = null;
  let bibleCurrentBookNum = $state<number | null>(null);
  let bibleCurrentChapter = $state<number | null>(null);
  let hasRequestedLibrarySync = $state(false);

  onMount(async () => {
    const creds = await loadCredentials();
    if (!creds?.device_token) {
      goto(`${base}/`);
      return;
    }
    await remote.connect();
    const hasAnyCache = ($songsStore?.length ?? 0) > 0 || (($bibleBooksStore?.length ?? 0) > 0 && ($bibleVersesStore?.length ?? 0) > 0);
    if ($connStatus === 'open' && !hasAnyCache) {
      hasRequestedLibrarySync = true;
      void syncNow();
    }
  });

  const hasLibrary = $derived(($songsStore?.length ?? 0) > 0);
  const hasBibleData = $derived(($bibleBooksStore?.length ?? 0) > 0 && ($bibleVersesStore?.length ?? 0) > 0);
  const bibleBookMap = $derived.by(() => new Map($bibleBooksStore.map((book) => [book.book_num, book])));
  const currentBibleBook = $derived(
    bibleCurrentBookNum === null ? null : (bibleBookMap.get(bibleCurrentBookNum) ?? null),
  );
  const currentBibleVerses = $derived.by(() => {
    if (bibleCurrentBookNum === null || bibleCurrentChapter === null) return [];
    return sortBibleVerses(
      $bibleVersesStore.filter(
        (verse) => verse.book_num === bibleCurrentBookNum && verse.chapter === bibleCurrentChapter,
      ),
    );
  });
  const currentBibleChapters = $derived.by(() => {
    if (!currentBibleBook) return [];
    return Array.from({ length: currentBibleBook.max_chapter }, (_, index) => index + 1);
  });

  $effect(() => {
    if ($connStatus !== 'open') {
      hasRequestedLibrarySync = false;
      return;
    }
    if (hasRequestedLibrarySync) return;
    if (isReducedDataConnection() && (hasLibrary || hasBibleData)) return;
    if (hasLibrary || hasBibleData) return;
    hasRequestedLibrarySync = true;
    void syncNow();
  });

  $effect(() => {
    const value = rawQuery;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      query = value;
    }, 200);
    return () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
    };
  });

  $effect(() => {
    const value = rawBibleQuery;
    if (bibleDebounceTimer !== null) clearTimeout(bibleDebounceTimer);
    bibleDebounceTimer = window.setTimeout(() => {
      bibleQuery = value;
    }, 180);
    return () => {
      if (bibleDebounceTimer !== null) clearTimeout(bibleDebounceTimer);
    };
  });

  $effect(() => {
    const el = sentinel;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          renderCount = Math.min(renderCount + 200, $songsStore.length);
        }
      },
      { rootMargin: '400px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  });

  type Entry = {
    s: LibrarySong;
    nName: string;
    nFolder: string;
    nSlides: string[] | null;
  };

  const index = $derived.by<Entry[]>(() =>
    $songsStore.map((song) => ({
      s: song,
      nName: song.normalized_name ?? normalize(song.name),
      nFolder: song.normalized_folder ?? normalize(song.folder),
      nSlides: song.normalized_blob ? song.normalized_blob.split(' | ') : null,
    })),
  );

  function slidesFor(entry: Entry): string[] {
    if (entry.nSlides) return entry.nSlides;
    entry.nSlides = entry.s.normalized_blob
      ? entry.s.normalized_blob.split(' | ')
      : (entry.s.slide_texts ?? []).map(normalize);
    return entry.nSlides;
  }

  const hasQuery = $derived(normalize(query).length > 0);
  const browseSongs = $derived<LibrarySong[]>(
    hasQuery ? [] : index.slice(0, renderCount).map((entry) => entry.s),
  );

  const grouped = $derived.by(() => {
    const groups = new Map<string, LibrarySong[]>();
    for (const song of browseSongs) {
      const key = song.folder || '-';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(song);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });

  type SongResult = { s: LibrarySong; score: number; snippet: string };
  const MAX_RESULTS = 200;

  const searchData = $derived.by<{ items: SongResult[]; overflow: boolean }>(() => {
    const q = normalize(query);
    if (!q) return { items: [], overflow: false };
    const names: SongResult[] = [];
    const folders: SongResult[] = [];
    const slideHits: SongResult[] = [];
    let overflow = false;

    for (const entry of index) {
      if (names.length + folders.length + slideHits.length >= MAX_RESULTS) {
        overflow = true;
        break;
      }
      if (entry.nName.includes(q)) {
        names.push({ s: entry.s, score: 3, snippet: '' });
      } else if (entry.nFolder.includes(q)) {
        folders.push({ s: entry.s, score: 2, snippet: '' });
      } else if (searchSlides) {
        // Fast rejection check using pre-normalized blob
        if (entry.s.normalized_blob && !entry.s.normalized_blob.includes(q)) {
          continue;
        }
        const normalizedSlides = slidesFor(entry);
        for (let slideIndex = 0; slideIndex < normalizedSlides.length; slideIndex++) {
          if (normalizedSlides[slideIndex] && normalizedSlides[slideIndex].includes(q)) {
            const hitIndex = normalizedSlides[slideIndex].indexOf(q);
            const raw = entry.s.slide_texts[slideIndex] ?? '';
            const start = Math.max(0, hitIndex - 20);
            const end = Math.min(raw.length, hitIndex + q.length + 40);
            const snippet =
              (start > 0 ? '...' : '') +
              raw.slice(start, end).trim() +
              (end < raw.length ? '...' : '');
            slideHits.push({ s: entry.s, score: 1, snippet });
            break;
          }
        }
      }
    }

    return { items: [...names, ...folders, ...slideHits], overflow };
  });

  const searchResults = $derived(searchData.items);
  const searchOverflow = $derived(searchData.overflow);

  const parsedBibleReference = $derived.by<BibleReferenceParse>(() =>
    parseBibleReference(bibleQuery, $bibleBooksStore),
  );

  const bibleReferenceBooks = $derived.by(() => {
    if (bibleSearchMode !== 'reference' || !bibleQuery) return [];
    const parsed = parsedBibleReference;
    if (parsed.exactBook && parsed.chapter) return [];
    return parsed.bookMatches.slice(0, 30);
  });

  const bibleReferenceChapters = $derived.by(() => {
    if (bibleSearchMode !== 'reference' || !bibleQuery) return [];
    const parsed = parsedBibleReference;
    if (!parsed.exactBook || parsed.chapter !== null) return [];
    return Array.from({ length: parsed.exactBook.max_chapter }, (_, index) => index + 1);
  });

  const bibleReferenceVerses = $derived.by(() => {
    if (bibleSearchMode !== 'reference' || !bibleQuery) return [];
    const parsed = parsedBibleReference;
    if (!parsed.exactBook || parsed.chapter === null) return [];
    const verses = $bibleVersesStore.filter(
      (verse) => verse.book_num === parsed.exactBook!.book_num && verse.chapter === parsed.chapter,
    );
    if (parsed.verse !== null) return verses.filter((verse) => verse.verse === parsed.verse);
    return sortBibleVerses(verses);
  });

  const bibleTextResults = $derived.by(() => {
    if (bibleSearchMode !== 'text') return [];
    const q = normalize(bibleQuery);
    if (!q) return [];
    const results: BibleVerse[] = [];
    for (const verse of $bibleVersesStore) {
      if ((verse.normalized_text ?? normalize(verse.text)).includes(q)) results.push(verse);
      if (results.length >= 120) break;
    }
    return results;
  });

  function parseBibleReference(queryText: string, books: BibleBook[]): BibleReferenceParse {
    const normalized = normalize(queryText);
    if (!normalized) {
      return { exactBook: null, bookMatches: books, chapter: null, verse: null };
    }

    const tokens = normalized.split(' ').filter(Boolean);
    const numberTokens: string[] = [];
    while (tokens.length > 1 && /^\d+$/.test(tokens[tokens.length - 1])) {
      numberTokens.unshift(tokens.pop()!);
    }
    const bookPart = tokens.join(' ').trim() || normalized;

    const booksWithNorm = books.map((book) => ({ book, norm: normalize(book.name) }));
    const exactBook =
      booksWithNorm
        .sort((a, b) => b.norm.length - a.norm.length)
        .find(({ norm }) =>
          normalized === norm ||
          normalized.startsWith(`${norm} `) ||
          (bookPart.length > 1 && norm.startsWith(bookPart)),
        )?.book ?? null;

    const bookMatches = booksWithNorm
      .filter(({ norm }) => {
        if (!bookPart) return true;
        return norm.includes(bookPart) || norm.startsWith(bookPart);
      })
      .map(({ book }) => book);

    return {
      exactBook,
      bookMatches,
      chapter: numberTokens[0] ? Number(numberTokens[0]) : null,
      verse: numberTokens[1] ? Number(numberTokens[1]) : null,
    };
  }

  function bibleVerseRef(verse: BibleVerse): string {
    return `${bibleBookMap.get(verse.book_num)?.name ?? 'Bible'} ${verse.chapter}:${verse.verse}`;
  }

  function addToQueue(path: string) {
    remote.send({ type: 'queue.add', payload: { song_path: path } });
  }

  function addBibleVerseToQueue(verse: BibleVerse) {
    const book = bibleBookMap.get(verse.book_num)?.name;
    if (!book) return;
    remote.send({
      type: 'queue.add_bible_verse',
      payload: { book, chapter: verse.chapter, verse: verse.verse },
    });
  }

  function openPreview(song: LibrarySong) {
    previewSong = song;
  }

  function closePreview() {
    previewSong = null;
    showProjector = false;
  }

  async function enterProjector() {
    showProjector = true;
    const docEl = document.documentElement as any;
    try {
      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen();
      } else if (docEl.webkitRequestFullscreen) {
        await docEl.webkitRequestFullscreen();
      } else if (docEl.mozRequestFullScreen) {
        await docEl.mozRequestFullScreen();
      } else if (docEl.msRequestFullscreen) {
        await docEl.msRequestFullscreen();
      }
    } catch (err) {
      console.warn('Failed to enter fullscreen:', err);
    }
  }

  function openBibleMenu() {
    goto('?mode=bible', { keepFocus: true, noScroll: true });
    bibleSearchMode = 'reference';
    bibleCurrentBookNum = null;
    bibleCurrentChapter = null;
    rawBibleQuery = '';
    bibleQuery = '';
  }

  function closeBibleMenu() {
    goto('?', { keepFocus: true, noScroll: true });
    rawBibleQuery = '';
    bibleQuery = '';
  }

  function enterBibleBook(bookNum: number) {
    bibleCurrentBookNum = bookNum;
    bibleCurrentChapter = null;
    rawBibleQuery = '';
    bibleQuery = '';
  }

  function enterBibleChapter(chapter: number) {
    bibleCurrentChapter = chapter;
    rawBibleQuery = '';
    bibleQuery = '';
  }

  function resetBibleNavigation() {
    bibleCurrentBookNum = null;
    bibleCurrentChapter = null;
  }

  function bibleStatusText(): string {
    if (!hasBibleData) return 'Waiting for Bible sync';
    if (bibleSearchMode === 'text' && bibleQuery) return `${bibleTextResults.length} matches`;
    if (bibleSearchMode === 'reference' && bibleQuery) {
      if (bibleReferenceVerses.length) return `${bibleReferenceVerses.length} verses`;
      if (bibleReferenceChapters.length) return `${bibleReferenceChapters.length} chapters`;
      return `${bibleReferenceBooks.length} books`;
    }
    if (bibleCurrentChapter !== null) return `${currentBibleVerses.length} verses`;
    if (currentBibleBook) return `${currentBibleBook.max_chapter} chapters`;
    return `${$bibleBooksStore.length} books`;
  }

  type WriteSongTab = 'link' | 'manual';
  let writeSongTab = $state<WriteSongTab>('link');
  let importUrl = $state('');
  let importLoading = $state(false);
  let importError = $state<string | null>(null);

  let songTitle = $state('');
  let songFolder = $state('Written Songs');
  let songLyrics = $state('');
  let songChorusIndex = $state<number | null>(null);
  let saveLoading = $state(false);
  let saveError = $state<string | null>(null);
  let showOverwriteConfirm = $state(false);

  function openWriteSongMenu() {
    goto('?mode=write_song', { keepFocus: true, noScroll: true });
    writeSongTab = 'link';
    importUrl = '';
    importError = null;
    songTitle = '';
    songFolder = 'Written Songs';
    songLyrics = '';
    songChorusIndex = null;
    saveError = null;
    showOverwriteConfirm = false;
  }

  function closeWriteSongMenu() {
    goto('?', { keepFocus: true, noScroll: true });
  }

  async function handleImportUrl() {
    if (!importUrl) {
      importError = 'Please enter a URL';
      return;
    }
    importLoading = true;
    importError = null;
    try {
      const res = await remote.sendRequest('song.fetch_rc', { url: importUrl });
      if (res.ok) {
        songTitle = res.title || '';
        songLyrics = (res.slides || []).join('\n\n');
        songChorusIndex = typeof res.chorus_index === 'number' ? res.chorus_index : null;
        writeSongTab = 'manual';
      } else {
        importError = res.error || 'Failed to fetch song from URL';
      }
    } catch (err: any) {
      importError = err.message || 'An error occurred during fetch';
    } finally {
      importLoading = false;
    }
  }

  const parsedSlides = $derived.by<string[]>(() => {
    return songLyrics
      .split('\n\n')
      .map(s => s.trim())
      .filter(Boolean);
  });

  async function handleSaveSong(overwrite = false) {
    if (!songTitle.trim()) {
      saveError = 'Song title is required';
      return;
    }
    const slides = parsedSlides;
    if (slides.length === 0) {
      saveError = 'Please enter song lyrics';
      return;
    }
    saveLoading = true;
    saveError = null;
    try {
      const res = await remote.sendRequest('song.create', {
        name: songTitle.trim(),
        slide_texts: slides,
        chorus_index: songChorusIndex,
        folder: songFolder.trim(),
        overwrite
      });
      if (res.ok) {
        showOverwriteConfirm = false;
        await syncNow();
        goto('?', { keepFocus: true, noScroll: true });
      } else if (res.error === 'already_exists') {
        showOverwriteConfirm = true;
      } else {
        saveError = res.error || 'Failed to save song';
      }
    } catch (err: any) {
      saveError = err.message || 'An error occurred';
    } finally {
      saveLoading = false;
    }
  }

  const ALL_KEYS = ['A', 'Am', 'A#', 'A#m', 'B', 'Bm', 'C', 'Cm', 'C#', 'C#m', 'D', 'Dm', 'D#', 'D#m', 'E', 'Em', 'F', 'Fm', 'F#', 'F#m', 'G', 'Gm', 'G#', 'G#m'];

  async function updateSongKey(songPath: string, key: string | null) {
    if (!$canEditKeys || $isViewOnly) return;
    try {
      const res = await remote.sendRequest('song.set_key', { song_path: songPath, key });
      if (res.ok) {
        songsStore.update(songs => {
          return songs.map(s => {
            if (s.path === songPath) {
              return { ...s, key };
            }
            return s;
          });
        });
        if (previewSong && previewSong.path === songPath) {
          previewSong.key = key;
        }
      } else {
        console.error('Failed to set key:', res.error);
      }
    } catch (err) {
      console.error('Error setting key:', err);
    }
  }
</script>

{#if libraryMode === 'songs'}
  <header class="hdr">
    <h1>Library</h1>
    <div class="muted small">
      {#if $syncStatus === 'syncing'}Syncing...
      {:else if $syncStatus === 'error'}Sync failed - tap refresh
      {:else if hasQuery}{searchResults.length}{searchOverflow ? '+' : ''} result{searchResults.length !== 1 ? 's' : ''}
      {:else}{$songsStore.length} songs{/if}
    </div>
  </header>

  <div class="quick-actions">
    <button class="action-card" type="button" onclick={openBibleMenu}>
      <div class="action-header">
        <span class="action-icon">📖</span>
        <span class="action-pill">{hasBibleData ? 'Open' : 'Sync'}</span>
      </div>
      <span class="action-title">Bible</span>
      <span class="action-desc">
        {#if hasBibleData}
          Search books, chapters & verses.
        {:else}
          Waiting for sync...
        {/if}
      </span>
    </button>

    <button class="action-card" type="button" onclick={openWriteSongMenu}>
      <div class="action-header">
        <span class="action-icon">✍️</span>
        <span class="action-pill">Write</span>
      </div>
      <span class="action-title">Write Song</span>
      <span class="action-desc">
        Write lyrics manually or fetch from link.
      </span>
    </button>
  </div>

  <section class="searchbar">
    <input
      type="text"
      placeholder="Search songs..."
      bind:value={rawQuery}
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
    />
    <label class="slides-toggle">
      <input type="checkbox" bind:checked={searchSlides} />
      Slides
    </label>
    <button
      class="refresh"
      aria-label="Refresh"
      onclick={() => void syncFull()}
      disabled={$syncStatus === 'syncing' || $connStatus !== 'open'}
    >R</button>
  </section>

  {#if !hasLibrary && $syncStatus !== 'syncing'}
    <section class="panel muted" style="margin-top:12px;">
      No songs cached yet. Pull once the desktop is connected.
    </section>
  {:else if hasQuery}
    {#if searchResults.length === 0}
      <section class="panel muted" style="margin-top:12px;">
        No songs match "{query}".
      </section>
    {:else}
      {#each searchResults as result (result.s.path)}
        <div class="song">
          <button class="song-main" onclick={() => openPreview(result.s)}>
            <div class="song-name-row" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%;">
              <div class="song-name">{result.s.name}</div>
              {#if result.s.key}
                <span class="key-badge">{result.s.key}</span>
              {/if}
            </div>
            <div class="muted small">{result.s.folder || '-'}</div>
            {#if result.snippet}
              <div class="snippet muted">{@html renderMarkdown(result.snippet)}</div>
            {/if}
          </button>
          <button
            class="add"
            aria-label="Add to queue"
            onclick={() => addToQueue(result.s.path)}
            disabled={$connStatus !== 'open' || $isViewOnly}
          >+</button>
        </div>
      {/each}
      {#if searchOverflow}
        <p class="muted small load-hint">Showing first {MAX_RESULTS} - type more to narrow results</p>
      {/if}
    {/if}
  {:else}
    {#each grouped as [folder, songs] (folder)}
      <section class="group">
        <div class="group-head">{folder}</div>
        {#each songs as song (song.path)}
          <div class="song">
            <button class="song-main" onclick={() => openPreview(song)}>
              <div class="song-name-row" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%;">
                <div class="song-name">{song.name}</div>
                {#if song.key}
                  <span class="key-badge">{song.key}</span>
                {/if}
              </div>
              {#if song.slide_texts?.length}
                <div class="muted small">{song.slide_texts.length} slides</div>
              {/if}
            </button>
            <button
              class="add"
              aria-label="Add to queue"
              onclick={() => addToQueue(song.path)}
              disabled={$connStatus !== 'open' || $isViewOnly}
            >+</button>
          </div>
        {/each}
      </section>
    {/each}

    {#if renderCount < $songsStore.length}
      <div bind:this={sentinel} class="sentinel" aria-hidden="true"></div>
      <p class="muted small load-hint">
        Showing {Math.min(renderCount, $songsStore.length)} of {$songsStore.length} - scroll for more
      </p>
    {/if}
  {/if}
{:else if libraryMode === 'bible'}
  <header class="hdr bible-hdr">
    <div>
      <h1>Bible</h1>
      <div class="muted small">{bibleStatusText()}</div>
    </div>
    <button
      class="refresh"
      aria-label="Refresh Bible data"
      onclick={() => void syncFull()}
      disabled={$syncStatus === 'syncing' || $connStatus !== 'open'}
    >R</button>
  </header>

  <button class="action-card nav-entry" type="button" onclick={closeBibleMenu} style="width: 100%; min-height: auto; flex-direction: row; align-items: center; gap: 12px; padding: 10px 14px;">
    <div class="action-icon" style="font-size: 16px;">←</div>
    <div class="action-info" style="flex: 1;">
      <span class="action-title" style="font-size: 14px; margin-bottom: 0;">Back to Songs</span>
    </div>
    <span class="action-pill">Songs</span>
  </button>

  <section class="bible-panel">
    <div class="mode-toggle">
      <button
        type="button"
        class:active={bibleSearchMode === 'reference'}
        onclick={() => { bibleSearchMode = 'reference'; resetBibleNavigation(); rawBibleQuery = ''; bibleQuery = ''; }}
      >
        Reference
      </button>
      <button
        type="button"
        class:active={bibleSearchMode === 'text'}
        onclick={() => { bibleSearchMode = 'text'; resetBibleNavigation(); rawBibleQuery = ''; bibleQuery = ''; }}
      >
        By Text
      </button>
    </div>

    <input
      type="text"
      placeholder={bibleSearchMode === 'reference' ? 'Search book, chapter, verse...' : 'Search Bible text...'}
      bind:value={rawBibleQuery}
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
    />

    {#if bibleSearchMode === 'reference' && (currentBibleBook || bibleCurrentChapter !== null)}
      <div class="crumbs">
        <button type="button" class="crumb" onclick={resetBibleNavigation}>All books</button>
        {#if currentBibleBook}
          <button type="button" class="crumb" onclick={() => { bibleCurrentChapter = null; }}>{currentBibleBook.name}</button>
        {/if}
        {#if bibleCurrentChapter !== null}
          <span class="crumb current">Chapter {bibleCurrentChapter}</span>
        {/if}
      </div>
    {/if}

    {#if !hasBibleData}
      <section class="panel muted bible-empty">
        Bible data has not reached the phone cache yet. Keep the desktop connected, then tap refresh.
      </section>
    {:else if bibleSearchMode === 'text'}
      {#if !bibleQuery}
        <section class="panel muted bible-empty">
          Search the synced Bible text to find verses by words or phrases.
        </section>
      {:else if bibleTextResults.length === 0}
        <section class="panel muted bible-empty">
          No verses match "{bibleQuery}".
        </section>
      {:else}
        <div class="bible-results">
          {#each bibleTextResults as verse (verse.id)}
            <div class="verse-row">
              <article class="verse-card">
                <div class="verse-ref">{bibleVerseRef(verse)}</div>
                <div class="verse-text">{verse.text}</div>
              </article>
              <button
                class="add verse-add"
                aria-label={`Add ${bibleVerseRef(verse)} to queue`}
                onclick={() => addBibleVerseToQueue(verse)}
                disabled={$connStatus !== 'open' || $isViewOnly}
              >+</button>
            </div>
          {/each}
        </div>
      {/if}
    {:else if bibleQuery}
      {#if bibleReferenceVerses.length}
        <div class="bible-results">
          {#each bibleReferenceVerses as verse (verse.id)}
            <div class="verse-row">
              <article class="verse-card">
                <div class="verse-ref">{bibleVerseRef(verse)}</div>
                <div class="verse-text">{verse.text}</div>
              </article>
              <button
                class="add verse-add"
                aria-label={`Add ${bibleVerseRef(verse)} to queue`}
                onclick={() => addBibleVerseToQueue(verse)}
                disabled={$connStatus !== 'open' || $isViewOnly}
              >+</button>
            </div>
          {/each}
        </div>
      {:else if bibleReferenceChapters.length}
        <div class="chapter-grid">
          {#each bibleReferenceChapters as chapter (chapter)}
            <button class="chapter-chip" type="button" onclick={() => enterBibleChapter(chapter)}>
              Chapter {chapter}
            </button>
          {/each}
        </div>
      {:else if bibleReferenceBooks.length}
        <div class="book-list">
          {#each bibleReferenceBooks as book (book.book_num)}
            <button class="book-card" type="button" onclick={() => enterBibleBook(book.book_num)}>
              <span class="book-name">{book.name}</span>
              <span class="muted small">{book.max_chapter} chapters</span>
            </button>
          {/each}
        </div>
      {:else}
        <section class="panel muted bible-empty">
          No Bible reference matches "{bibleQuery}".
        </section>
      {/if}
    {:else if bibleCurrentChapter !== null}
      <div class="bible-results">
        {#each currentBibleVerses as verse (verse.id)}
          <div class="verse-row">
            <article class="verse-card">
              <div class="verse-ref">{bibleVerseRef(verse)}</div>
              <div class="verse-text">{verse.text}</div>
            </article>
            <button
              class="add verse-add"
              aria-label={`Add ${bibleVerseRef(verse)} to queue`}
              onclick={() => addBibleVerseToQueue(verse)}
              disabled={$connStatus !== 'open' || $isViewOnly}
            >+</button>
          </div>
        {/each}
      </div>
    {:else if currentBibleBook}
      <div class="chapter-grid">
        {#each currentBibleChapters as chapter (chapter)}
          <button class="chapter-chip" type="button" onclick={() => enterBibleChapter(chapter)}>
            Chapter {chapter}
          </button>
        {/each}
      </div>
    {:else}
      <div class="book-list">
        {#each $bibleBooksStore as book (book.book_num)}
          <button class="book-card" type="button" onclick={() => enterBibleBook(book.book_num)}>
            <span class="book-name">{book.name}</span>
            <span class="muted small">{book.max_chapter} chapters</span>
          </button>
        {/each}
      </div>
    {/if}
  </section>
{:else if libraryMode === 'write_song'}
  <header class="hdr bible-hdr">
    <div>
      <h1>Write Song</h1>
      <div class="muted small">Create a custom song or import from web</div>
    </div>
    <button
      class="refresh"
      aria-label="Back to library"
      onclick={closeWriteSongMenu}
    >←</button>
  </header>

  <section class="bible-panel">
    <div class="mode-toggle">
      <button
        type="button"
        class:active={writeSongTab === 'link'}
        onclick={() => { writeSongTab = 'link'; }}
      >
        Import Link
      </button>
      <button
        type="button"
        class:active={writeSongTab === 'manual'}
        onclick={() => { writeSongTab = 'manual'; }}
      >
        Lyrics Editor
      </button>
    </div>

    {#if writeSongTab === 'link'}
      <div class="form-group">
        <label for="import-url" class="form-label">Resurse Crestine URL</label>
        <input
          id="import-url"
          type="text"
          placeholder="https://www.resursecrestine.ro/cantari/..."
          bind:value={importUrl}
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
        />
        {#if importError}
          <p class="error-text">{importError}</p>
        {/if}
        <button
          type="button"
          class="accent fw"
          onclick={handleImportUrl}
          disabled={importLoading}
        >
          {#if importLoading}Fetching...{:else}Fetch & Edit{/if}
        </button>
        <div class="import-help muted small">
          Enter a song link from resursecrestine.ro to automatically download and parse the title, slides, and chorus.
        </div>
      </div>
    {:else}
      <div class="form-group">
        <label for="song-title" class="form-label">Song Title</label>
        <input
          id="song-title"
          type="text"
          placeholder="Enter title..."
          bind:value={songTitle}
          autocomplete="off"
        />

        <label for="song-folder" class="form-label">Folder / Category</label>
        <input
          id="song-folder"
          type="text"
          placeholder="Written Songs"
          bind:value={songFolder}
          autocomplete="off"
        />

        <label for="song-lyrics" class="form-label">Lyrics</label>
        <textarea
          id="song-lyrics"
          placeholder="Enter lyrics here. Use two blank lines to separate slides."
          bind:value={songLyrics}
          rows="10"
        ></textarea>

        {#if parsedSlides.length > 0}
          <div class="slide-previews-header">
            <span class="form-label">Slide Previews</span>
            <span class="muted small">Tap a slide to toggle it as the Chorus</span>
          </div>
          <div class="slide-previews-list">
            {#each parsedSlides as slide, i}
              <button
                type="button"
                class="slide-prev-item"
                class:is-chorus={songChorusIndex === i}
                onclick={() => {
                  songChorusIndex = songChorusIndex === i ? null : i;
                }}
              >
                <div class="slide-prev-badge">
                  {#if songChorusIndex === i}
                    Chorus
                  {:else}
                    Slide {i + 1}
                  {/if}
                </div>
                <div class="slide-prev-text">{slide}</div>
              </button>
            {/each}
          </div>
        {/if}

        {#if saveError}
          <p class="error-text">{saveError}</p>
        {/if}

        <button
          type="button"
          class="accent fw"
          onclick={() => handleSaveSong(false)}
          disabled={saveLoading || $connStatus !== 'open' || $isViewOnly}
        >
          {#if saveLoading}Saving...{:else}Save to Library{/if}
        </button>
      </div>
    {/if}
  </section>
{/if}

{#if previewSong}
  <div
    class="modal-back"
    role="button"
    tabindex="-1"
    aria-label="Close preview"
    onclick={closePreview}
    onkeydown={(e) => { if (e.key === 'Escape') closePreview(); }}
  >
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <div class="modal-head" style="flex-direction: column; align-items: stretch; gap: 8px;">
        <div class="modal-title-row" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%;">
          <div class="modal-title" style="flex: 1; font-weight: 700; font-size: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{previewSong.name}</div>
          <div class="key-section" style="flex-shrink: 0; display: flex; align-items: center;">
            {#if $canEditKeys && !$isViewOnly}
              <select
                class="key-select"
                value={previewSong.key || ''}
                onchange={(e) => updateSongKey(previewSong!.path, e.currentTarget.value || null)}
                style="background: var(--elevated); border: 1px solid var(--border); border-radius: 6px; color: var(--accent); font-size: 13px; font-weight: 700; padding: 4px 8px; cursor: pointer; outline: none;"
              >
                <option value="">No Key</option>
                {#each ALL_KEYS as k}
                  <option value={k}>{k}</option>
                {/each}
              </select>
            {:else if previewSong.key}
              <span class="key-display-badge" style="background: color-mix(in srgb, var(--accent) 12%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); color: var(--accent); font-size: 13px; font-weight: 700; padding: 4px 8px; border-radius: 6px; display: inline-block;">Key: {previewSong.key}</span>
            {/if}
          </div>
          <button class="ghost" style="padding: 6px 12px; font-size: 13px; flex-shrink: 0;" onclick={closePreview}>Close</button>
        </div>
        
        <div style="display: flex; gap: 8px; width: 100%; margin-top: 4px; margin-bottom: 8px;">
          <button
            class="accent"
            style="flex: 2; padding: 10px 14px; font-size: 14px;"
            onclick={() => { if (previewSong) addToQueue(previewSong.path); closePreview(); }}
            disabled={$connStatus !== 'open' || $isViewOnly}
          >
            + Add to queue
          </button>
          <button
            class="ghost"
            style="flex: 1; padding: 10px 14px; font-size: 14px; border-color: var(--accent); color: var(--accent);"
            onclick={enterProjector}
          >
            Projector Show
          </button>
        </div>
      </div>
      {#each previewSong.slide_texts as slide, i (i)}
        <div class="slide-prev" class:chorus={previewSong.chorus_index === i}>
          {#each slide.split('\n') as line}
            <div>{@html renderMarkdown(line) || '\u00A0'}</div>
          {/each}
        </div>
      {/each}
    </div>
  </div>
{/if}

{#if showProjector && previewSong}
  <ProjectorOverlay song={previewSong} onclose={() => { showProjector = false; }} />
{/if}

{#if showOverwriteConfirm}
  <div
    class="modal-back"
    role="button"
    tabindex="-1"
    aria-label="Close confirm"
    onclick={() => { showOverwriteConfirm = false; }}
    onkeydown={(e) => { if (e.key === 'Escape') showOverwriteConfirm = false; }}
  >
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <div class="modal-head">
        <div class="modal-title">Song Already Exists</div>
      </div>
      <p style="margin: 12px 0; font-size: 14px; line-height: 1.5; color: var(--text-secondary);">
        A song named "<strong>{songTitle}</strong>" already exists in the library. Do you want to overwrite it?
      </p>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 16px;">
        <button class="ghost" onclick={() => { showOverwriteConfirm = false; }}>
          Cancel
        </button>
        <button class="accent" onclick={() => handleSaveSong(true)} disabled={saveLoading}>
          {#if saveLoading}Overwriting...{:else}Overwrite{/if}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .hdr { display:flex; align-items:flex-end; justify-content:space-between; gap:12px; padding: 4px 0 10px; }
  .bible-hdr { align-items: flex-start; }
  h1 { margin:0; font-size: 22px; font-weight: 700; }
  .small { font-size: 12px; }
 
  .quick-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin: 0 0 12px;
  }
  .action-card {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: space-between;
    padding: 10px 12px;
    border-radius: 12px;
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--panel) 72%, transparent), color-mix(in srgb, var(--surface) 88%, transparent)),
      var(--surface);
    border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border));
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    text-align: left;
    transition: background 150ms ease, border-color 150ms ease, transform 100ms ease, box-shadow 150ms ease;
    cursor: pointer;
    min-height: 94px;
    box-sizing: border-box;
  }
  .action-card:hover {
    border-color: var(--accent);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }
  .action-card:active {
    transform: scale(0.97);
  }
  .nav-entry {
    margin-bottom: 12px;
  }
  .action-header {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }
  .action-icon {
    font-size: 16px;
    line-height: 1;
  }
  .action-pill {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 2px 6px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--accent) 50%, var(--border));
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--accent);
    line-height: 1;
  }
  .action-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--text-primary);
    margin-bottom: 1px;
  }
  .action-desc {
    font-size: 10px;
    color: var(--text-secondary);
    line-height: 1.35;
  }
 
  .searchbar {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 12px;
  }
  .searchbar input[type="text"] { flex: 1; }
  .slides-toggle {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .refresh {
    width: 40px;
    height: 40px;
    padding: 0;
    font-size: 14px;
    line-height: 1;
    font-weight: 700;
  }
 
  .group { margin-bottom: 14px; }
  .group-head {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    color: var(--text-secondary);
    padding: 8px 2px 4px;
    font-weight: 700;
  }
 
  .song {
    display: flex;
    gap: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 4px;
    margin-bottom: 6px;
    transition: border-color 150ms ease, background-color 150ms ease;
  }
  .song:hover {
    border-color: var(--accent);
    background: var(--panel);
  }
  .song-main {
    flex: 1;
    text-align: left;
    background: transparent;
    border: none;
    padding: 10px 12px;
    color: var(--text-primary);
    border-radius: 8px;
    transition: background-color 150ms ease;
  }
  .song-main:active {
    background: rgba(255, 255, 255, 0.04);
  }
  .song-name { font-weight: 600; }
  .snippet {
    font-size: 11px;
    font-style: italic;
    margin-top: 3px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 240px;
  }
 
  .add {
    width: 52px;
    font-size: 20px;
    font-weight: 700;
    color: var(--accent);
    border-color: var(--border);
    transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, transform 100ms ease;
  }
  .add:hover:not(:disabled) {
    background: var(--panel);
    border-color: var(--accent);
    color: var(--accent-hover);
  }
  .add:active:not(:disabled) {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    transform: scale(0.93);
  }
 
  .bible-panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .mode-toggle {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .mode-toggle button.active {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 700;
    box-shadow: 0 2px 8px rgba(233, 69, 96, 0.3);
  }
  .crumbs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .crumb {
    padding: 7px 12px;
    border-radius: 999px;
    font-size: 12px;
    transition: background-color 150ms ease, border-color 150ms ease, transform 100ms ease;
  }
  .crumb:active {
    transform: scale(0.95);
  }
  .crumb.current {
    display: inline-flex;
    align-items: center;
    padding: 7px 12px;
    border-radius: 999px;
    border: 1px solid var(--accent);
    color: var(--accent);
    font-size: 12px;
    font-weight: 700;
    box-shadow: 0 0 8px rgba(233, 69, 96, 0.15);
  }
  .book-list,
  .bible-results {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .verse-row {
    display: flex;
    gap: 8px;
    align-items: stretch;
  }
  .book-card,
  .verse-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px;
    transition: background-color 150ms ease, border-color 150ms ease, transform 100ms ease;
  }
  .book-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    text-align: left;
  }
  .book-card:hover {
    border-color: var(--accent);
    background: var(--panel);
  }
  .book-card:active {
    transform: scale(0.98);
  }
  .verse-card { flex: 1; }
  .verse-add {
    width: 52px;
    flex: 0 0 52px;
    align-self: stretch;
  }
  .book-name {
    font-size: 16px;
    font-weight: 700;
    color: var(--text-primary);
  }
  .chapter-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .chapter-chip {
    min-height: 52px;
    font-weight: 600;
    transition: background-color 150ms ease, border-color 150ms ease, transform 100ms ease;
  }
  .chapter-chip:hover:not(:disabled) {
    border-color: var(--accent);
    background: var(--panel);
  }
  .chapter-chip:active:not(:disabled) {
    transform: scale(0.96);
  }
  .verse-ref {
    color: var(--accent);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.3px;
    text-transform: uppercase;
    margin-bottom: 6px;
  }
  .verse-text {
    line-height: 1.55;
    white-space: pre-wrap;
  }
  .bible-empty { margin: 0; }
 
  .sentinel { height: 1px; }
  .load-hint { text-align: center; padding: 6px 0 10px; margin: 0; }
 
  .modal-back {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 100;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px 14px 0 0;
    width: 100%;
    max-width: 720px;
    max-height: 90vh;
    overflow-y: auto;
    padding: 16px;
    box-shadow: 0 -4px 30px rgba(0, 0, 0, 0.35);
  }
  .modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .modal-title { font-weight: 700; font-size: 18px; }
  button.ghost {
    background: transparent;
    border-color: var(--border);
    color: var(--text-secondary);
  }
  button.accent.fw { width: 100%; padding: 14px; margin-top: 12px; }
 
  .slide-prev {
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    margin-bottom: 6px;
    white-space: pre-wrap;
    line-height: 1.4;
    font-size: 13px;
    transition: border-color 150ms ease;
  }
  .slide-prev:hover {
    border-color: var(--border-light);
  }
  .slide-prev.chorus {
    background: var(--chorus-tint);
    border-color: var(--chorus-border);
    color: #fff;
    box-shadow: 0 0 10px rgba(124, 58, 237, 0.15);
  }
 
  @media (max-width: 560px) {
    .chapter-grid {
      grid-template-columns: 1fr 1fr;
    }
    .book-card {
      flex-direction: column;
      align-items: flex-start;
    }
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 16px;
  }
  .form-label {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--accent);
    margin-top: 8px;
  }
  .form-label:first-of-type {
    margin-top: 0;
  }
  textarea {
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 14px;
    resize: vertical;
  }
  textarea:focus {
    border-color: var(--accent);
    outline: none;
  }
  .error-text {
    color: #ef4444;
    font-size: 13px;
    margin: 4px 0;
  }
  .import-help {
    line-height: 1.4;
    margin-top: 4px;
  }
  .slide-previews-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 16px;
  }
  .slide-previews-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 6px;
  }
  .slide-prev-item {
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    text-align: left;
    transition: border-color 150ms ease, background-color 150ms ease;
    cursor: pointer;
    position: relative;
  }
  .slide-prev-item:hover {
    border-color: var(--border-light);
  }
  .slide-prev-item.is-chorus {
    background: var(--chorus-tint);
    border-color: var(--chorus-border);
  }
  .slide-prev-badge {
    position: absolute;
    top: 8px;
    right: 8px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-secondary);
  }
  .slide-prev-item.is-chorus .slide-prev-badge {
    color: var(--accent);
  }
  .slide-prev-text {
    font-size: 13px;
    line-height: 1.4;
    white-space: pre-wrap;
    padding-right: 60px; /* space for badge */
  }
</style>
