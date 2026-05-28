# Graph Report - phone-remote  (2026-05-28)

## Corpus Check
- 25 files · ~114,415 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 268 nodes · 573 edges · 19 communities (16 shown, 3 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ee701674`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]

## God Nodes (most connected - your core abstractions)
1. `openDb()` - 26 edges
2. `_doSync()` - 22 edges
3. `$lib/ProjectorOverlay.svelte` - 16 edges
4. `RemoteClient` - 15 edges
5. `restoreServerData()` - 14 edges
6. `setMeta()` - 12 edges
7. `_getServerByKey()` - 12 edges
8. `removeServer()` - 11 edges
9. `importBackup()` - 11 edges
10. `clearCredentials()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `if()` --calls--> `hydrateFromCache()`  [INFERRED]
  src/routes/+layout.svelte → src/lib/sync.ts
- `_doSync()` --calls--> `sortBibleVerses()`  [EXTRACTED]
  src/lib/sync.ts → /home/potato/Seafile/My Library/Projects/Python/ChurchPresenterRedesign/phone-remote/src/lib/bible.ts
- `handleSaveSong()` --calls--> `syncNow()`  [INFERRED]
  src/routes/library/+page.svelte → src/lib/sync.ts
- `syncNow()` --calls--> `getLastSyncTs()`  [EXTRACTED]
  src/lib/sync.ts → src/lib/db.ts
- `syncNow()` --calls--> `loadAllBibleBooks()`  [EXTRACTED]
  src/lib/sync.ts → src/lib/db.ts

## Communities (19 total, 3 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.06
Nodes (52): compareBibleVerses(), sortBibleVerses(), clearPendingMutations(), Credentials, getPendingMutations(), loadAllServers(), AuthFail, AuthFirstPair (+44 more)

### Community 1 - "Community 1"
Cohesion: 0.13
Nodes (49): addPendingMutation(), BackupComparison, BackupData, cacheQueueState(), clearBibleBooks(), clearBibleVerses(), clearCredentials(), clearLists() (+41 more)

### Community 2 - "Community 2"
Cohesion: 0.1
Nodes (30): ../app.css, $lib/db, $lib/protocol, $lib/search, $lib/stores, $lib/sync, $lib/ws, ../app.css (+22 more)

### Community 3 - "Community 3"
Cohesion: 0.05
Nodes (26): $lib/bible, $lib/bible, [], ALL_KEYS, bibleBookMap, currentBibleBook, currentBibleChapters, currentBibleVerses (+18 more)

### Community 4 - "Community 4"
Cohesion: 0.12
Nodes (15): Church Presenter — Phone Remote (PWA), code:bash (cd phone-remote), Connection, Connection Modes, Dev Setup, Development Workflow, Features, Library Browser (+7 more)

### Community 6 - "Community 6"
Cohesion: 0.31
Nodes (7): clearAll(), ghostStyle, onDragEnd(), remove(), send(), showConfirm(), tapJump()

### Community 7 - "Community 7"
Cohesion: 0.53
Nodes (4): filterSongs(), matchScore(), normalize(), ScoredResult

### Community 8 - "Community 8"
Cohesion: 0.6
Nodes (3): handler(), main(), Phase 0 WebSocket echo server.  Run this, then `cloudflared tunnel --url http://

## Knowledge Gaps
- **67 isolated node(s):** `active`, `../app.css`, `ghostStyle`, `hasLibrary`, `hasBibleData` (+62 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `syncNow()` connect `Community 1` to `Community 0`?**
  _High betweenness centrality (0.138) - this node is a cross-community bridge._
- **Why does `handleSaveSong()` connect `Community 1` to `Community 3`?**
  _High betweenness centrality (0.137) - this node is a cross-community bridge._
- **Why does `RemoteClient` connect `Community 5` to `Community 0`?**
  _High betweenness centrality (0.069) - this node is a cross-community bridge._
- **What connects `active`, `../app.css`, `ghostStyle` to the rest of the system?**
  _67 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.06 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.13 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._