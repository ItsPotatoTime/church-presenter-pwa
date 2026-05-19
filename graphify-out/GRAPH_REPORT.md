# Graph Report - phone-remote  (2026-05-19)

## Corpus Check
- 23 files · ~110,806 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 208 nodes · 454 edges · 15 communities (12 shown, 3 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1e2e03e4`
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
- [[_COMMUNITY_Community 10|Community 10]]

## God Nodes (most connected - your core abstractions)
1. `openDb()` - 26 edges
2. `_doSync()` - 18 edges
3. `RemoteClient` - 14 edges
4. `restoreServerData()` - 14 edges
5. `setMeta()` - 12 edges
6. `_getServerByKey()` - 12 edges
7. `removeServer()` - 11 edges
8. `importBackup()` - 11 edges
9. `clearCredentials()` - 10 edges
10. `snapshotServerData()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `if()` --calls--> `hydrateFromCache()`  [INFERRED]
  src/routes/+layout.svelte → src/lib/sync.ts
- `_doSync()` --calls--> `getBibleVersion()`  [EXTRACTED]
  src/lib/sync.ts → src/lib/db.ts
- `_doSync()` --calls--> `snapshotServerData()`  [EXTRACTED]
  src/lib/sync.ts → src/lib/db.ts
- `syncNow()` --calls--> `getLastSyncTs()`  [EXTRACTED]
  src/lib/sync.ts → src/lib/db.ts
- `syncNow()` --calls--> `loadAllBibleBooks()`  [EXTRACTED]
  src/lib/sync.ts → src/lib/db.ts

## Communities (15 total, 3 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.06
Nodes (43): cacheQueueState(), Credentials, AuthFail, AuthFirstPair, AuthOk, AuthReconnect, BibleBook, BibleRef (+35 more)

### Community 1 - "Community 1"
Cohesion: 0.17
Nodes (37): sortBibleVerses(), addPendingMutation(), BackupComparison, BackupData, clearBibleBooks(), clearBibleVerses(), clearCredentials(), clearLists() (+29 more)

### Community 2 - "Community 2"
Cohesion: 0.07
Nodes (17): $lib/bible, [], bibleBookMap, currentBibleBook, currentBibleChapters, currentBibleVerses, end, grouped (+9 more)

### Community 3 - "Community 3"
Cohesion: 0.19
Nodes (15): ../app.css, $lib/db, $lib/protocol, $lib/search, $lib/stores, $lib/sync, $lib/ws, off (+7 more)

### Community 4 - "Community 4"
Cohesion: 0.24
Nodes (16): compareBackup(), exportBackup(), getBibleVersion(), getCachedQueueState(), getLastSyncTs(), loadAllBibleBooks(), loadAllBibleVerses(), loadAllLists() (+8 more)

### Community 5 - "Community 5"
Cohesion: 0.12
Nodes (15): Church Presenter — Phone Remote (PWA), code:bash (cd phone-remote), Connection, Connection Modes, Dev Setup, Development Workflow, Features, Library Browser (+7 more)

### Community 7 - "Community 7"
Cohesion: 0.53
Nodes (4): filterSongs(), matchScore(), normalize(), ScoredResult

## Knowledge Gaps
- **52 isolated node(s):** `Phase 0 WebSocket echo server.  Run this, then `cloudflared tunnel --url http://`, `active`, `../app.css`, `data`, `off` (+47 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `RemoteClient` connect `Community 6` to `Community 0`?**
  _High betweenness centrality (0.080) - this node is a cross-community bridge._
- **Why does `hydrateFromCache()` connect `Community 4` to `Community 3`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **Why does `if()` connect `Community 3` to `Community 4`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **What connects `Phase 0 WebSocket echo server.  Run this, then `cloudflared tunnel --url http://`, `active`, `../app.css` to the rest of the system?**
  _52 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.06 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.07 - nodes in this community are weakly interconnected._
- **Should `Community 5` be split into smaller, more focused modules?**
  _Cohesion score 0.12 - nodes in this community are weakly interconnected._