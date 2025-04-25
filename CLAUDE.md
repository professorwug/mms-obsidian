# MMS Project Guidelines

## Project Overview
MMS (Maps, Masterplans & Searches) is an Obsidian plugin that constructs a hierarchical directed acyclic graph from files using node IDs in filenames.

### Folgezettel Naming Pattern

The plugin uses an alternating Folgezettel naming pattern to create a hierarchical structure:

1. **Level 1 (Root)**: Two digits 
   - Examples: "01", "02", "42"
   - These form the top level of the hierarchy

2. **Level 2**: Parent ID + one letter 
   - Examples: "01a", "01b", "42z"
   - These are direct children of a root node

3. **Level 3**: Parent ID + two digits
   - Examples: "01a01", "01a02", "42z99"
   - These are children of level 2 nodes

4. **Level 4**: Parent ID + one letter
   - Examples: "01a01a", "01a01b", "42z99c"
   - These are children of level 3 nodes

5. **Level 5**: Parent ID + two digits
   - Examples: "01a01a01", "01a01b42", "42z99c77"
   - These are children of level 4 nodes

The pattern continues with **strict alternation** between adding:
- A single letter (for even-numbered levels)
- Two digits (for odd-numbered levels)

**Special Nodes**:
- **Mapping Nodes**: IDs ending with "%" (e.g., "01a%", "01a01%")
- **Planning Nodes**: IDs ending with "&" (e.g., "42b&", "42b03&")

**Finding Parent IDs**:
- The parent of any node can be found by removing the last segment
- For nodes ending with a letter (e.g., "01a"), remove the letter → "01"
- For nodes ending with two digits (e.g., "01a01"), remove the two digits → "01a"

**Generated Child IDs**:
- New children follow the alternation pattern
- If parent ends with digits, add the next available letter
- If parent ends with a letter, add the next available two-digit number (starting from 01)

This naming system creates a clearly readable, sortable hierarchy where each ID encodes its complete ancestry while maintaining a consistent pattern at each level.

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