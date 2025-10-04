# File Tree Alternative Parity Notes

## Access limitations
- Attempted to clone `ozntel/file-tree-alternative` but outbound HTTPS is blocked in this environment, so the codebase could not be inspected directly from the container. A local checkout would be needed to perform a full diff-based review.

## Known strengths of File Tree Alternative
Although the source could not be downloaded during this session, File Tree Alternative is documented by its maintainers and the Obsidian community as focusing on responsiveness with large vaults, configurable sorting, and quick access affordances (favorites, focus filters, recent list). Those are useful guideposts when evaluating MMS' current implementation.

## Recommendations for MMS
1. **Persist and diff the file graph instead of rebuilding it on every vault change.**
   - Today `updateGraph` reads the entire vault, re-sorts every entry, rebuilds the `FileGraph`, and pushes it to all subscribers whenever Obsidian emits create/delete/rename events. That strategy becomes expensive as vaults scale into tens of thousands of files. Introducing an incremental graph cache that updates only the touched nodes would reduce the amount of work triggered by each event.
2. **Defer child hydration and adopt virtualization for the React tree.**
   - MMS renders every visible subtree recursively and keeps the whole graph in component state. File Tree Alternative keeps the UI responsive by expanding folders lazily and windowing the visible rows. Pairing lazy loading with a virtualized list (e.g., `react-window`) would significantly reduce the number of DOM nodes React needs to reconcile.
3. **Extract stateful logic for drag/drop and reordering into dedicated hooks or controllers.**
   - The current `FileBrowserComponent` mixes rendering with large imperative sections for drag handling, id regeneration, rename rollbacks, and notices. Breaking those flows into focused helpers (for example a drag controller that exposes `begin`, `hover`, `commit`, `cancel`) mirrors the modular structure used in File Tree Alternative and would make it easier to reason about side effects and reuse the logic across views.
4. **Add quick filters and pin/favorites collections.**
   - File Tree Alternative surfaces frequently used folders through favorites and provides quick filter inputs. MMS can replicate the UX by layering a lightweight filtering state over the cached graph and exposing a favorites data structure in plugin settings. Caching the filtered result per query or favorite would allow instant toggling without re-walking the vault.
5. **Normalize ID parsing utilities so they can be reused by worker threads or background tasks.**
   - Consolidating Folgezettel parsing into a pure module unlocks the option of pre-processing IDs off the main thread (File Tree Alternative batches file metadata parsing). That would let MMS precompute graph diffs without blocking the UI thread when vault changes arrive in bursts.

Each recommendation should be validated once the File Tree Alternative code is accessible locally so we can mirror concrete implementation patterns (e.g., how they structure virtualization or caching layers).
