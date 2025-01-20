import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile, TFolder, TAbstractFile } from 'obsidian';
import { FileBrowserView } from './FileBrowserView';
import { FolgemoveModal } from './FolgemoveModal';
import { FollowUpModal } from './FollowUpModal';
import { getNextAvailableChildId } from './utils';
import { FileGraph, buildFileGraph } from './FileGraph';

// Remember to rename these classes and interfaces!

interface MMSPluginSettings {
    fileTypeCommands: {
        [key: string]: string;
        py: string;
        ipynb: string;
        qmd: string;
        nb: string;
        pdf: string;
    };
}

const DEFAULT_SETTINGS: MMSPluginSettings = {
    fileTypeCommands: {
        py: 'code "$FILEPATH"',
        ipynb: 'code "$FILEPATH"',
        qmd: 'code "$FILEPATH"',
        nb: 'open "$FILEPATH"',
        pdf: '',
    }
}

export default class MMSPlugin extends Plugin {
    settings: MMSPluginSettings;
    private views: FileBrowserView[] = [];
    private fileGraph: FileGraph;

    async onload() {
        await this.loadSettings();

        // Register the custom view type
        this.registerView(
            'folgezettel-browser',
            (leaf: WorkspaceLeaf) => {
                const view = new FileBrowserView(leaf, this);
                this.views.push(view);
                return view;
            }
        );

        // Register file system event handlers
        this.registerEvent(
            this.app.vault.on('create', () => this.refreshViews())
        );
        this.registerEvent(
            this.app.vault.on('delete', () => this.refreshViews())
        );
        this.registerEvent(
            this.app.vault.on('rename', () => this.refreshViews())
        );

        // Add a ribbon icon for the Folgezettel Browser
        const folgezettelRibbonIconEl = this.addRibbonIcon('folder', 'Folgezettel Browser', async (evt: MouseEvent) => {
            await this.activateView();
        });
        folgezettelRibbonIconEl.addClass('folgezettel-browser-ribbon-class');

        // Automatically open the file browser view
        this.app.workspace.onLayoutReady(() => {
            this.activateView();
        });

        // This creates an icon in the left ribbon.
        const ribbonIconEl = this.addRibbonIcon('dice', 'Sample Plugin', (evt: MouseEvent) => {
            // Called when the user clicks the icon.
            new Notice('This is a notice!');
        });
        // Perform additional things with the ribbon
        ribbonIconEl.addClass('my-plugin-ribbon-class');

        // This adds a status bar item to the bottom of the app. Does not work on mobile apps.
        const statusBarItemEl = this.addStatusBarItem();
        statusBarItemEl.setText('Status Bar Text');

        // This adds a simple command that can be triggered anywhere
        this.addCommand({
            id: 'open-sample-modal-simple',
            name: 'Open sample modal (simple)',
            callback: () => {
                new SampleModal(this.app).open();
            }
        });
        // This adds an editor command that can perform some operation on the current editor instance
        this.addCommand({
            id: 'sample-editor-command',
            name: 'Sample editor command',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                console.log(editor.getSelection());
                editor.replaceSelection('Sample Editor Command');
            }
        });
        // This adds a complex command that can check whether the current state of the app allows execution of the command
        this.addCommand({
            id: 'open-sample-modal-complex',
            name: 'Open sample modal (complex)',
            checkCallback: (checking: boolean) => {
                // Conditions to check
                const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (markdownView) {
                    // If checking is true, we're simply "checking" if the command can be run.
                    // If checking is false, then we want to actually perform the operation.
                    if (!checking) {
                        new SampleModal(this.app).open();
                    }

                    // This command will only show up in Command Palette when the check function returns true
                    return true;
                }
            }
        });

        // Add Folgemove command
        this.addCommand({
            id: 'folgemove',
            name: 'Folgemove - Move file and its descendants',
            callback: async () => {
                const activeFile = this.app.workspace.getActiveFile();
                if (!activeFile) {
                    new Notice('No active file');
                    return;
                }

                // Open modal to select destination
                const modal = new FolgemoveModal(this.app);
                modal.open();
                const target = await modal.getResult();
                
                if (!target) return; // User cancelled

                await this.folgemove(activeFile, target.path);
            }
        });

        // Add Create Follow Up Note command
        this.addCommand({
            id: 'create-follow-up-note',
            name: 'Create Follow Up Note',
            checkCallback: (checking: boolean) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (!activeFile) return false;

                if (checking) return true;

                this.createFollowUpNote(activeFile);
                return true;
            }
        });

        // This adds a settings tab so the user can configure various aspects of the plugin
        this.addSettingTab(new MMSSettingTab(this.app, this));

        // If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
        // Using this function will automatically remove the event listener when this plugin is disabled.
        this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
            console.log('click', evt);
        });

        // When registering intervals, this function will automatically clear the interval when the plugin is disabled.
        this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
    }

    onunload() {
        this.views = [];
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        console.log('Loaded settings:', this.settings);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async activateView() {
        const { workspace } = this.app;

        let leaf = workspace.getLeavesOfType('folgezettel-browser')[0];
        if (!leaf) {
            const newLeaf = workspace.getLeftLeaf(false);
            if (!newLeaf) {
                throw new Error('Could not create leaf for folgezettel-browser');
            }
            await newLeaf.setViewState({ type: 'folgezettel-browser' });
            leaf = newLeaf;
        }

        workspace.revealLeaf(leaf);
    }

    // Method to refresh all file browser views while preserving state
    private refreshViews() {
        this.views.forEach(view => {
            if (view) {
                view.refreshPreservingState();
            }
        });
    }

    private getActiveGraph(): FileGraph {
        const fileBrowserView = this.views.find(view => view instanceof FileBrowserView) as FileBrowserView;
        if (!fileBrowserView) {
            throw new Error('File browser not initialized');
        }
        const currentGraph = fileBrowserView.getCurrentGraph();
        if (!currentGraph) {
            throw new Error('Graph not initialized');
        }
        return currentGraph;
    }

    private async waitForGraphUpdate(timeout = 2000): Promise<void> {
        console.log(`[WaitForGraph] Waiting for graph update`);
        const fileBrowserView = this.views.find(view => view instanceof FileBrowserView) as FileBrowserView;
        if (!fileBrowserView) {
            throw new Error('File browser not initialized');
        }

        return new Promise((resolve, reject) => {
            let timeoutId: NodeJS.Timeout;
            
            // Function to clean up listeners
            const cleanup = () => {
                clearTimeout(timeoutId);
                fileBrowserView.app.workspace.off('file-menu', menuHandler);
                fileBrowserView.app.vault.off('rename', renameHandler);
            };

            // Set timeout
            timeoutId = setTimeout(() => {
                cleanup();
                reject(new Error('Timeout waiting for graph update'));
            }, timeout);

            // Handler for file menu events
            const menuHandler = () => {
                cleanup();
                resolve();
            };

            // Handler for rename events
            const renameHandler = () => {
                cleanup();
                resolve();
            };

            // Register event listeners
            fileBrowserView.app.workspace.on('file-menu', menuHandler);
            fileBrowserView.app.vault.on('rename', renameHandler);
        });
    }

    async folgemove(source: TAbstractFile, targetPath: string) {
        try {
            console.log(`[Folgemove] Starting move of ${source.path} to ${targetPath}`);
            const graph = this.getActiveGraph();

            // Get target node
            const targetNode = graph.nodes.get(targetPath);
            if (!targetNode) {
                throw new Error(`Target node ${targetPath} not found in graph`);
            }

            // Get all children BEFORE moving the source node
            console.log(`[Folgemove] Getting children before moving source`);
            const children = this.getChildrenToMove(source.path);
            console.log(`[Folgemove] Found ${children.length} children to move:`, children.map(c => c.path));

            // Move the source node and get its new path
            console.log(`[Folgemove] Moving source node ${source.path}`);
            const newPath = await this.moveSingleNode(source, targetPath);
            if (!newPath) {
                throw new Error('Failed to move source node');
            }
            console.log(`[Folgemove] Source node moved to ${newPath}`);
            
            // Wait for graph to update after moving source
            console.log(`[Folgemove] Waiting for graph update after source move`);
            try {
                await this.waitForGraphUpdate();
                console.log(`[Folgemove] Graph updated after source move`);
            } catch (error) {
                console.warn(`[Folgemove] Warning: ${error.message}`);
            }
            
            // Move children recursively
            if (children.length > 0) {
                console.log(`[Folgemove] Starting recursive move of children to ${newPath}`);
                await this.moveChildrenRecursively(children, newPath);
            }

        } catch (error) {
            console.error('[Folgemove] Error:', error);
            new Notice(`Error moving file: ${error.message}`);
        }
    }

    private async moveSingleNode(source: TAbstractFile, targetPath: string): Promise<string | null> {
        try {
            console.log(`[MoveSingle] Moving ${source.path} under ${targetPath}`);
            const graph = this.getActiveGraph();
            const targetNode = graph.nodes.get(targetPath);
            if (!targetNode) {
                throw new Error(`Target node ${targetPath} not found in graph`);
            }

            // Get source node to check for multiple paths
            const sourceNode = graph.nodes.get(source.path);
            if (!sourceNode) {
                throw new Error(`Source node ${source.path} not found in graph`);
            }

            // Get next available child ID for the target
            const newId = getNextAvailableChildId(targetPath, graph);
            if (!newId) {
                throw new Error('Could not generate new ID');
            }
            console.log(`[MoveSingle] Generated new ID: ${newId}`);

            // Move each file with the same ID but different extensions
            let primaryNewPath: string | null = null;
            for (const sourcePath of sourceNode.paths) {
                const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
                if (!sourceFile || !(sourceFile instanceof TFile)) continue;

                // Create new filename with the new ID but keep original extension
                const baseName = sourceNode.name;
                const extension = sourceFile.extension;
                const newName = `${newId} ${baseName}.${extension}`;
                console.log(`[MoveSingle] New filename for extension ${extension}: ${newName}`);

                // Determine the new path
                const targetFolder = targetNode.isDirectory ? targetPath : this.app.vault.getAbstractFileByPath(targetPath)?.parent?.path || '';
                const newPath = `${targetFolder}/${newName}`;
                console.log(`[MoveSingle] Moving ${sourcePath} to ${newPath}`);

                // Move the file
                await this.app.fileManager.renameFile(sourceFile, newPath);
                console.log(`[MoveSingle] Successfully moved to ${newPath}`);

                // Store the first new path as the primary path
                if (!primaryNewPath) {
                    primaryNewPath = newPath;
                }
            }

            return primaryNewPath;
        } catch (error) {
            console.error('[MoveSingle] Error:', error);
            return null;
        }
    }

    private getChildrenToMove(sourcePath: string): TAbstractFile[] {
        console.log(`[GetChildren] Finding children of ${sourcePath}`);
        const graph = this.getActiveGraph();
        const children: TAbstractFile[] = [];
        const childPaths = graph.edges.get(sourcePath) || new Set<string>();
        console.log(`[GetChildren] Found edges:`, Array.from(childPaths));

        for (const childPath of childPaths) {
            const file = this.app.vault.getAbstractFileByPath(childPath);
            if (file) {
                children.push(file);
                console.log(`[GetChildren] Added child: ${file.path}`);
            } else {
                console.log(`[GetChildren] Warning: Could not find file for path: ${childPath}`);
            }
        }

        // Sort children to ensure consistent ordering
        const sortedChildren = children.sort((a, b) => a.path.localeCompare(b.path));
        console.log(`[GetChildren] Final sorted children:`, sortedChildren.map(c => c.path));
        return sortedChildren;
    }

    private async moveChildrenRecursively(children: TAbstractFile[], newParentPath: string) {
        console.log(`[MoveChildren] Moving ${children.length} children to ${newParentPath}`);
        for (const child of children) {
            console.log(`[MoveChildren] Processing child: ${child.path}`);
            
            // Get grandchildren BEFORE moving the child
            const grandchildren = this.getChildrenToMove(child.path);
            console.log(`[MoveChildren] Found ${grandchildren.length} grandchildren for ${child.path}:`, grandchildren.map(c => c.path));
            
            // Move this child to be under the new parent
            const newChildPath = await this.moveSingleNode(child, newParentPath);
            if (!newChildPath) {
                console.log(`[MoveChildren] Failed to move child: ${child.path}`);
                continue;
            }
            console.log(`[MoveChildren] Moved child to: ${newChildPath}`);

            // Wait for graph to update after moving child
            console.log(`[MoveChildren] Waiting for graph update after child move`);
            try {
                await this.waitForGraphUpdate();
                console.log(`[MoveChildren] Graph updated after child move`);
            } catch (error) {
                console.warn(`[MoveChildren] Warning: ${error.message}`);
            }

            // Move grandchildren recursively if any were found
            if (grandchildren.length > 0) {
                console.log(`[MoveChildren] Starting recursive move of ${grandchildren.length} grandchildren to ${newChildPath}`);
                await this.moveChildrenRecursively(grandchildren, newChildPath);
            }
        }
    }

    async createFollowUpNote(activeFile: TFile) {
        try {
            const graph = this.getActiveGraph();

            // Get parent node from graph
            const parentPath = activeFile.path;
            const parentNode = graph.nodes.get(parentPath);
            if (!parentNode || !parentNode.id) {
                new Notice('Parent note must have an ID');
                return;
            }

            // Show modal to get note name and type
            const modal = new FollowUpModal(this.app);
            const result = await modal.openAndGetValue();
            if (!result) return; // User cancelled

            // Get ID based on note type
            let newId: string;
            if (result.type === 'searching') {
                // For searching notes, get next available child ID
                newId = getNextAvailableChildId(parentPath, graph);
                if (!newId) {
                    new Notice('Could not generate child ID');
                    return;
                }
            } else {
                // For mapping and planning notes, use parent's ID with appropriate suffix
                newId = result.type === 'mapping' ? `${parentNode.id}#` : `${parentNode.id}&`;
            }

            // Create the new file
            const newFileName = `${newId} ${result.name}.md`;
            const newFilePath = `${activeFile.parent?.path ?? ''}/${newFileName}`;
            
            const newFile = await this.app.vault.create(newFilePath, '');
            new Notice(`Created ${result.type} note: ${newFileName}`);
            
            // Open the new file in a new tab
            await this.app.workspace.getLeaf('tab').openFile(newFile);
        } catch (error) {
            console.error('Error creating follow up note:', error);
            new Notice('Error creating follow up note');
        }
    }

    private ensureGraphInitialized() {
        if (!this.fileGraph) {
            const files = this.app.vault.getFiles();
            const folders = this.app.vault.getAllLoadedFiles().filter(f => f instanceof TFolder) as TFolder[];
            const items = [...files, ...folders];
            this.fileGraph = buildFileGraph(items);
        }
    }
}

class SampleModal extends Modal {
    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.setText('Woah!');
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class MMSSettingTab extends PluginSettingTab {
    plugin: MMSPlugin;

    constructor(app: App, plugin: MMSPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'File Type Actions' });
        containerEl.createEl('p', { text: 'Configure commands to run when clicking different file types. Leave empty to use default behavior.' });
        containerEl.createEl('p', { text: 'Use $FILEPATH in your command where you want the file path to be inserted. For example: code "$FILEPATH" or open -a "Preview" "$FILEPATH"' });

        const fileTypes = ['py', 'ipynb', 'qmd', 'nb', 'pdf'];

        for (const ext of fileTypes) {
            new Setting(containerEl)
                .setName(`${ext.toUpperCase()} files`)
                .setDesc(`Command to run for .${ext} files`)
                .addText(text => text
                    .setPlaceholder(`Command for .${ext} files`)
                    .setValue(this.plugin.settings.fileTypeCommands[ext])
                    .onChange(async (value) => {
                        this.plugin.settings.fileTypeCommands[ext] = value;
                        await this.plugin.saveSettings();
                    }));
        }
    }
}
