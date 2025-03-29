# MMS Project Guidelines

## Project Overview
MMS (Maps, Masterplans & Searches) is an Obsidian plugin that constructs a hierarchical directed acyclic graph from files using node IDs in filenames. Node IDs follow the pattern '03j91l02e': two numbers, a non-numeric character, two numbers, etc. Children of '03' are '03a', '03b'; children of '03a' are '03a01', '03a02'. Parent nodes are found by removing the last segment from the ID.

## Build Commands
- `npm run dev` - Development build with watch mode
- `npm run build` - Production build with type checking
- `npm run version` - Bump version and update manifest

## Lint Commands
- Lint TypeScript: `npx eslint **/*.{ts,tsx}`
- Fix lint issues: `npx eslint **/*.{ts,tsx} --fix`

## Test Commands
- Run Python tests: `cd archived_code/python && pytest`
- Single test: `cd archived_code/python && pytest tests/test_file.py::test_function -v`

## Code Style Guidelines
- **TypeScript**: Strict null checks, no implicit any
- **Formatting**: 2-space indentation
- **Imports**: Use ES modules with synthetic default imports
- **Naming**: camelCase for variables/functions, PascalCase for classes
- **React**: Function components with hooks
- **File Graph**: Access through `plugin.getActiveGraph()`, subscribe to updates

## Working with the File Graph
- Get current graph: `const graph = plugin.getActiveGraph()`
- Subscribe to updates: `plugin.subscribeToGraphUpdates(callback)`
- After file operations: `await plugin.waitForGraphUpdate()`
- Avoid rebuilding the graph manually
- Prefer subscription over polling for updates