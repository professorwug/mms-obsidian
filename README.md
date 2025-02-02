# Obsidian Sample Plugin

This is a sample plugin for Obsidian (https://obsidian.md).

This project uses TypeScript to provide type checking and documentation.
The repo depends on the latest plugin API (obsidian.d.ts) in TypeScript Definition format, which contains TSDoc comments describing what it does.

This sample plugin demonstrates some of the basic functionality the plugin API can do.
- Adds a ribbon icon, which shows a Notice when clicked.
- Adds a command "Open Sample Modal" which opens a Modal.
- Adds a plugin setting tab to the settings page.
- Registers a global click event and output 'click' to the console.
- Registers a global interval which logs 'setInterval' to the console.

## First time developing plugins?

Quick starting guide for new plugin devs:

- Check if [someone already developed a plugin for what you want](https://obsidian.md/plugins)! There might be an existing plugin similar enough that you can partner up with.
- Make a copy of this repo as a template with the "Use this template" button (login to GitHub if you don't see it).
- Clone your repo to a local development folder. For convenience, you can place this folder in your `.obsidian/plugins/your-plugin-name` folder.
- Install NodeJS, then run `npm i` in the command line under your repo folder.
- Run `npm run dev` to compile your plugin from `main.ts` to `main.js`.
- Make changes to `main.ts` (or create new `.ts` files). Those changes should be automatically compiled into `main.js`.
- Reload Obsidian to load the new version of your plugin.
- Enable plugin in settings window.
- For updates to the Obsidian API run `npm update` in the command line under your repo folder.

## Releasing new releases

- Update your `manifest.json` with your new version number, such as `1.0.1`, and the minimum Obsidian version required for your latest release.
- Update your `versions.json` file with `"new-plugin-version": "minimum-obsidian-version"` so older versions of Obsidian can download an older version of your plugin that's compatible.
- Create new GitHub release using your new version number as the "Tag version". Use the exact version number, don't include a prefix `v`. See here for an example: https://github.com/obsidianmd/obsidian-sample-plugin/releases
- Upload the files `manifest.json`, `main.js`, `styles.css` as binary attachments. Note: The manifest.json file must be in two places, first the root path of your repository and also in the release.
- Publish the release.

> You can simplify the version bump process by running `npm version patch`, `npm version minor` or `npm version major` after updating `minAppVersion` manually in `manifest.json`.
> The command will bump version in `manifest.json` and `package.json`, and add the entry for the new version to `versions.json`

## Adding your plugin to the community plugin list

- Check the [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines).
- Publish an initial version.
- Make sure you have a `README.md` file in the root of your repo.
- Make a pull request at https://github.com/obsidianmd/obsidian-releases to add your plugin.

## How to use

- Clone this repo.
- Make sure your NodeJS is at least v16 (`node --version`).
- `npm i` or `yarn` to install dependencies.
- `npm run dev` to start compilation in watch mode.

## Manually installing the plugin

- Copy over `main.js`, `styles.css`, `manifest.json` to your vault `VaultFolder/.obsidian/plugins/your-plugin-id/`.

## Improve code quality with eslint (optional)
- [ESLint](https://eslint.org/) is a tool that analyzes your code to quickly find problems. You can run ESLint against your plugin to find common bugs and ways to improve your code. 
- To use eslint with this project, make sure to install eslint from terminal:
  - `npm install -g eslint`
- To use eslint to analyze this project use this command:
  - `eslint main.ts`
  - eslint will then create a report with suggestions for code improvement by file and line number.
- If your source code is in a folder, such as `src`, you can use eslint with this command to analyze all files in that folder:
  - `eslint .\src\`

## Funding URL

You can include funding URLs where people who use your plugin can financially support it.

The simple way is to set the `fundingUrl` field to your link in your `manifest.json` file:

```json
{
    "fundingUrl": "https://buymeacoffee.com"
}
```

If you have multiple URLs, you can also do:

```json
{
    "fundingUrl": {
        "Buy Me a Coffee": "https://buymeacoffee.com",
        "GitHub Sponsor": "https://github.com/sponsors",
        "Patreon": "https://www.patreon.com/"
    }
}
```

## API Documentation

See https://github.com/obsidianmd/obsidian-api

## File Graph Architecture

The plugin maintains a centralized file graph that represents all files and folders in the vault, along with their relationships. This graph is used for features like file browsing, folgezettel navigation, and file operations.

### Graph Structure

The file graph consists of:
- **Nodes**: Represent files and folders, storing metadata like:
  - Path
  - Display name
  - Folgezettel ID (if present)
  - Node type (mapping, planning)
  - File extensions
  - Directory status
  - Surrogate status (for placeholder nodes)
- **Edges**: Represent parent-child relationships between nodes

### Graph Management

The graph is managed centrally by the MMSPlugin class to ensure consistency and prevent unnecessary rebuilds:

```typescript
// Access the graph from a command or view
const graph = plugin.getActiveGraph();

// Subscribe to graph updates
plugin.subscribeToGraphUpdates((newGraph) => {
    // Handle graph update
});
```

The graph is automatically refreshed when:
- Files are created, deleted, or renamed
- Folders are created, deleted, or renamed
- The plugin is loaded

Graph updates are debounced (100ms) to prevent rapid rebuilds during batch operations.

### Best Practices

When implementing commands or views that need graph access:

1. **Accessing the Graph**:
   ```typescript
   // Get the current graph
   const graph = plugin.getActiveGraph();
   
   // Wait for graph update after file operations
   await plugin.waitForGraphUpdate();
   ```

2. **Subscribing to Updates**:
   ```typescript
   // Subscribe in onload() or onOpen()
   plugin.subscribeToGraphUpdates((graph) => {
       // Update your view/state
   });
   
   // Unsubscribe in onunload() or onClose()
   plugin.unsubscribeFromGraphUpdates(callback);
   ```

3. **File Operations**:
   - After modifying files, wait for the graph to update before accessing it
   - Use `waitForGraphUpdate()` to ensure the graph reflects recent changes

4. **Performance**:
   - Don't rebuild the graph manually; use the central instance
   - Cache graph data in views instead of rebuilding
   - Subscribe to updates instead of polling

### Ignore Patterns

The graph builder supports ignore patterns to exclude certain files and folders:
- Patterns are configured in plugin settings
- Uses minimatch syntax (like .gitignore)
- Common patterns: `.*`, `__pycache__`, `.git`, etc.
- Patterns are applied to full file paths
