# MMS Plugin Architecture

This document provides an overview of how the "Maps, Masterplans & Searches" (MMS) plugin is structured and how its parts interact. The code base is written in TypeScript and bundled with `esbuild`.

## Entry point

- **`main.ts`** – Implements `MMSPlugin`, the main class extending Obsidian's `Plugin` API. It loads settings, registers commands, event handlers and views, and exposes utility methods.
  - Maintains a **file graph** used by the browser view.
  - Manages **Marimo** notebook instances when Python files are opened.
  - Provides commands such as *Folgemove*, *Create Follow Up Note*, *Rename with Extensions* and others.
  - Emits graph update callbacks so other components can stay in sync.

## File graph

- **`FileGraph.ts`** – Defines the `GraphNode` and `FileGraph` interfaces and contains logic to build a hierarchical graph from the vault based on Folgezettel IDs.
  - Functions like `isValidNodeId` and `getParentId` parse node IDs.
  - `buildFileGraph` scans vault files/folders, applying ignore patterns from plugin settings and creating surrogate nodes when parents are missing.

## React based browser view

- **`FileBrowserView.tsx`** – Custom `ItemView` that renders the hierarchical browser using React.
  - Uses `buildFileGraph` to display files and folders in a tree.
  - Handles selection, expansion state, drag‑and‑drop reordering and context menus.
  - Relies on methods from `MMSPlugin` (opening files, folgemove, renaming, etc.).
  - Subscribes to graph updates to refresh when the vault changes.

## Modal dialogs

- **`FollowUpModal.ts`** – Prompts the user for a new follow‑up note name and type.
- **`FolgemoveModal.ts`** – Fuzzy search modal used to choose a new parent when moving notes.
- **`RenameModal.ts`** – Simple dialog for renaming a file and all its extension variants.
- **`RenameSymbolsModal.ts`** – Guides the user through replacing problematic characters in filenames.

## Utilities

- **`utils.ts`** – Helper functions for platform checks, executing shell commands, path handling and Folgezettel ID generation.
  - Provides `getProblematicSymbols` used throughout the code to sanitise filenames.

## Other files

- **`ReactView.tsx`** – Minimal example view using React (not heavily integrated).
- **`styles.css`** – Styling for the browser view and modals.
- **`esbuild.config.mjs`** – Build script that bundles the plugin for development or production.
- **`archived_code/`** – Historical files kept for reference.

## Workflow

1. **Loading** – When the plugin loads, `onload` in `main.ts` builds the initial graph and registers a custom view type `folgezettel-browser`.
2. **Graph updates** – File system events (`create`, `delete`, `rename`) trigger a debounced rebuild of the graph. Views subscribe via `plugin.subscribeToGraphUpdates` and refresh when updates occur.
3. **User actions** – Commands and context menu actions call methods on `MMSPlugin`. Many of these manipulate files, then wait for a graph refresh (`waitForGraphUpdate`) before continuing.
4. **Marimo integration** – Python files can be opened locally or remotely using Marimo. The plugin manages spawned processes and optionally syncs files when running on a remote host.

This architecture keeps a single source of truth (the file graph) while presenting a React‑based interface for exploring and manipulating notes.
