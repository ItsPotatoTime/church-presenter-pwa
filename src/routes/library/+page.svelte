<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
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
  } from '$lib/stores';
  import { remote } from '$lib/ws';

  type LibraryMode = 'songs' | 'bible';
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
  let debounceTimer: number | null = null;
  let renderCount = $state(300);
  let sentinel = $state<Element | null>(null);

  let libraryMode = $state<LibraryMode>('songs');
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
    return $bibleVersesStore.filter(
      (verse) => verse.book_num === bibleCurrentBookNum && verse.chapter === bibleCurrentChapter,
    );
  });
  const currentBibleChapters = $derived.by(() => {
    if (!currentBibleBook) return [];
    return Array.from({ length: currentBibleBook.max_chapter }, (_, index) => index + 1);
  });

  $effect(() => {
    if ($connStatus !== 'open' || hasRequestedLibrarySync) return;
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
      nName: normalize(song.name),
      nFolder: normalize(song.folder),
      nSlides: null,
    })),
  );

  function slidesFor(entry: Entry): string[] {
    if (entry.nSlides) return entry.nSlides;
    entry.nSlides = (entry.s.slide_texts ?? []).map(normalize);
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
        const normalizedSlides = slidesFor(entry);
        for (let slideIndex = 0; slideIndex < normalizedSlides.length; slideIndex++) {
          if (normalizedSlides[slideIndex].includes(q)) {
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
    return verses;
  });

  const bibleTextResults = $derived.by(() => {
    if (bibleSearchMode !== 'text') return [];
    const q = normalize(bibleQuery);
    if (!q) return [];
    const results: BibleVerse[] = [];
    for (const verse of $bibleVersesStore) {
      if (normalize(verse.text).includes(q)) results.push(verse);
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
  }

  function openBibleMenu() {
    libraryMode = 'bible';
    bibleSearchMode = 'reference';
    bibleCurrentBookNum = null;
    bibleCurrentChapter = null;
    rawBibleQuery = '';
    bibleQuery = '';
  }

  function closeBibleMenu() {
    libraryMode = 'songs';
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

  <button class="bible-entry" type="button" onclick={openBibleMenu}>
    <div class="bible-copy">
      <span class="bible-kicker">{hasBibleData ? 'Synced on phone' : 'Waiting for sync'}</span>
      <span class="bible-title">Bible</span>
      <span class="bible-desc">
        {#if hasBibleData}
          Open the Bible menu to search books, chapters, verses, and passage text.
        {:else}
          Open the Bible menu now. It will fill in as soon as the desktop sends Bible data.
        {/if}
      </span>
    </div>
    <span class="bible-pill">Open</span>
  </button>

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
            <div class="song-name">{result.s.name}</div>
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
              <div class="song-name">{song.name}</div>
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
{:else}
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

  <button class="bible-entry nav-entry" type="button" onclick={closeBibleMenu}>
    <div class="bible-copy">
      <span class="bible-kicker">Library navigation</span>
      <span class="bible-title">Songs</span>
      <span class="bible-desc">
        Return to the songs menu to browse folders, search titles, and add songs to the queue.
      </span>
    </div>
    <span class="bible-pill">Open</span>
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
      <div class="modal-head">
        <div class="modal-title">{previewSong.name}</div>
        <button class="ghost" onclick={closePreview}>Close</button>
      </div>
      {#each previewSong.slide_texts as slide, i (i)}
        <div class="slide-prev" class:chorus={previewSong.chorus_index === i}>
          {#each slide.split('\n') as line}
            <div>{@html renderMarkdown(line) || '\u00A0'}</div>
          {/each}
        </div>
      {/each}
      <button
        class="accent fw"
        onclick={() => { if (previewSong) addToQueue(previewSong.path); closePreview(); }}
        disabled={$connStatus !== 'open' || $isViewOnly}
      >
        + Add to queue
      </button>
    </div>
  </div>
{/if}

<style>
  .hdr { display:flex; align-items:flex-end; justify-content:space-between; gap:12px; padding: 4px 0 10px; }
  .bible-hdr { align-items: flex-start; }
  h1 { margin:0; font-size: 22px; font-weight: 700; }
  .small { font-size: 12px; }

  .bible-entry {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    margin: 0 0 14px;
    padding: 14px 16px;
    border-radius: 16px;
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--panel) 72%, transparent), color-mix(in srgb, var(--surface) 88%, transparent)),
      var(--surface);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    text-align: left;
  }
  .nav-entry {
    margin-bottom: 12px;
  }
  .bible-copy {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .bible-kicker {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    color: var(--accent);
    font-weight: 700;
  }
  .bible-title {
    font-size: 18px;
    font-weight: 700;
    color: var(--text-primary);
  }
  .bible-desc {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.4;
  }
  .bible-pill {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 34px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--accent) 60%, var(--border));
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.2px;
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
    letter-spacing: 1px;
    color: var(--text-secondary);
    padding: 8px 2px 4px;
  }

  .song {
    display: flex;
    gap: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 4px;
    margin-bottom: 6px;
  }
  .song-main {
    flex: 1;
    text-align: left;
    background: transparent;
    border: none;
    padding: 10px 12px;
    color: var(--text-primary);
    border-radius: 8px;
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
  }
  .book-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    text-align: left;
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
  }
  .slide-prev.chorus { background: var(--chorus-tint); color: #fff; }

  @media (max-width: 560px) {
    .chapter-grid {
      grid-template-columns: 1fr 1fr;
    }
    .book-card {
      flex-direction: column;
      align-items: flex-start;
    }
  }
</style>
