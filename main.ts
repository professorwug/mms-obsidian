import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile, TFolder, TAbstractFile } from 'obsidian';
import { FileBrowserView } from './FileBrowserView';
import { FolgemoveModal } from './FolgemoveModal';
import { FollowUpModal } from './FollowUpModal';
import { RenameModal } from './RenameModal';
import { RenameSymbolsModal } from './RenameSymbolsModal';
import { getNextAvailableChildId, isMobileApp, executeCommand, getPlatformAppropriateFilePath, findFilesWithProblematicSymbols, getProblematicSymbols } from './utils';
import { FileGraph, buildFileGraph, GraphNode } from './FileGraph';

// Remember to rename these classes and interfaces!

interface FileTypeCommands {
    [key: string]: string;
    py: string;
    ipynb: string;
    qmd: string;
    nb: string;
    pdf: string;
}

interface MMSPluginSettings {
    fileTypeCommands: FileTypeCommands;
    htmlBehavior: 'obsidian' | 'browser';
    useMarimo: boolean;
    marimoLocalCommand: string;
    marimoRemoteCommand: string;
    marimoRemoteHost: string;
    marimoRemoteUser: string;
    marimoRemoteKeyPath: string;
    marimoRemoteSync: boolean;
    marimoRemoteVaultPath: string;
    ignorePatterns: string[];
    autoRevealFiles: boolean;
    folgezettelBrowserFontSize: number;
}

const DEFAULT_SETTINGS: MMSPluginSettings = {
    fileTypeCommands: {
        py: 'code "$FILEPATH"',
        ipynb: 'code "$FILEPATH"',
        qmd: 'code "$FILEPATH"',
        nb: 'code "$FILEPATH"',
        pdf: 'open "$FILEPATH"'
    },
    htmlBehavior: 'obsidian',
    useMarimo: false,
    marimoLocalCommand: 'marimo edit --watch $FILEPATH --port $PORT --token-password $PASSWORD --headless',
    marimoRemoteCommand: 'marimo edit --watch $FILEPATH --port $PORT --token-password $PASSWORD --headless',
    marimoRemoteHost: '',
    marimoRemoteUser: '',
    marimoRemoteKeyPath: '',
    marimoRemoteSync: true,
    marimoRemoteVaultPath: '',
    ignorePatterns: [
        '.*',           // Hidden files and directories
        '__pycache__',  // Python cache directories (anywhere in path)
        '*.pyc',        // Python compiled files
        '.git',         // Git directory
        '.obsidian'     // Obsidian settings directory
    ],
    autoRevealFiles: false,
    folgezettelBrowserFontSize: 14
}

function generateRandomPort(): number {
    // Generate a random port between 2000 and 65535
    return Math.floor(Math.random() * (65535 - 2000 + 1)) + 2000;
}

function generateRandomPassword(): string {
    // Generate a random 32-character hex string
    return Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

interface MarimoInstance {
    port: number;
    password: string;
    process: any; // Child process handle
    watchProcess?: any;  // Process for file watching
    remotePath?: string; // Path on remote server
    syncInterval?: NodeJS.Timeout; // Interval for bidirectional sync
    lastSyncTime?: number; // Last time the file was synced
}

interface IMMSPlugin {
    settings: MMSPluginSettings;
    app: App;
    createFollowUpNote: (item: TAbstractFile) => void;
    folgemove: (file: TFile, targetPath: string) => void;
    openMarimoNotebook: (file: TFile) => void;
    openRemoteMarimoNotebook: (file: TFile, node: GraphNode) => void;
    executeDefaultPythonCommand: (file: TFile) => void;
    renameFileWithExtensions: (file: TFile, newName: string) => Promise<void>;
}

export default class MMSPlugin extends Plugin implements IMMSPlugin {
    settings: MMSPluginSettings;
    private views: FileBrowserView[] = [];
    private fileGraph: FileGraph | null = null;
    private marimoInstances: Map<string, MarimoInstance> = new Map();
    private graphUpdateCallbacks: Set<(graph: FileGraph) => void> = new Set();
    private fileOpenSource: string | null = null; // Track if file was opened from the browser

    // Method to set the file open source (used by FileBrowserView)
    setFileOpenSource(source: string | null) {
        this.fileOpenSource = source;
        
        // Reset the source after a short delay
        if (source) {
            setTimeout(() => {
                this.fileOpenSource = null;
            }, 100);
        }
    }
    
    // Check if a file has a valid folgezettel prefix
    hasValidFolgezettelPrefix(file: TFile): boolean {
        const graph = this.getActiveGraph();
        const node = graph.nodes.get(file.path);
        return node?.id ? true : false;
    }

    // Check if the folgezettel browser view is visible
    isFolgezettelBrowserVisible(): boolean {
        const leaves = this.app.workspace.getLeavesOfType('folgezettel-browser');
        return leaves.length > 0;
    }
    
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

        // Register file system event handlers with debounced graph update
        let updateTimeout: NodeJS.Timeout | null = null;
        const debouncedUpdate = () => {
            if (updateTimeout) {
                clearTimeout(updateTimeout);
            }
            updateTimeout = setTimeout(() => {
                this.updateGraph();
                this.refreshViews();
            }, 100); // Debounce graph updates
        };

        this.registerEvent(
            this.app.vault.on('create', debouncedUpdate)
        );
        this.registerEvent(
            this.app.vault.on('delete', debouncedUpdate)
        );
        this.registerEvent(
            this.app.vault.on('rename', debouncedUpdate)
        );
        
        // Register event for file open to auto-reveal in folgezettel browser
        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (!file) return;
                
                // We only want to auto-reveal if:
                // 1. Auto-reveal is enabled in settings
                // 2. The browser view is visible
                // 3. The file has a valid folgezettel prefix
                // 4. The file wasn't opened from the browser itself
                const shouldAutoReveal = 
                    this.settings.autoRevealFiles &&
                    this.isFolgezettelBrowserVisible() && 
                    this.hasValidFolgezettelPrefix(file) && 
                    this.fileOpenSource !== 'browser';
                
                if (shouldAutoReveal) {
                    console.log(`[MMS] Auto-revealing file: ${file.path}`);
                    // Slight delay to ensure everything is loaded
                    setTimeout(() => {
                        this.revealFileInFolgezettelBrowser(file);
                    }, 50);
                }
            })
        );

        // Add a ribbon icon for the Folgezettel Browser
        const folgezettelRibbonIconEl = this.addRibbonIcon('list-ordered', 'Folgezettel Browser', async (evt: MouseEvent) => {
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

        // Add Shutdown Marimo Servers command
        this.addCommand({
            id: 'shutdown-marimo-servers',
            name: 'Shutdown All Marimo Servers',
            callback: () => {
                this.shutdownAllMarimoServers();
            }
        });
        
        // Add Fix Special Characters in Filenames command
        this.addCommand({
            id: 'fix-special-characters',
            name: 'Fix Special Characters in Filenames',
            callback: async () => {
                // Find files with problematic characters
                const problematicFiles = findFilesWithProblematicSymbols(this.app);
                
                if (problematicFiles.length === 0) {
                    new Notice('No files with special characters found.');
                    return;
                }
                
                // Open the modal to let the user choose which symbol to replace
                const modal = new RenameSymbolsModal(this.app, problematicFiles);
                const result = await modal.openAndGetValue();
                
                if (!result) {
                    // User cancelled
                    return;
                }
                
                // Process files based on user selection
                let processedCount = 0;
                let errorCount = 0;
                
                for (const file of problematicFiles) {
                    try {
                        // Check if the file contains the target symbol
                        if (result.targetSymbol && !file.basename.includes(result.targetSymbol)) {
                            continue;
                        }
                        
                        // Create new name by replacing the target symbol
                        let newName = file.basename;
                        if (result.targetSymbol) {
                            // Replace specific symbol
                            newName = newName.split(result.targetSymbol).join(result.replacementSymbol);
                        } else {
                            // Replace all problematic symbols
                            const problematicSymbols = getProblematicSymbols();
                            for (const symbol of problematicSymbols) {
                                newName = newName.split(symbol).join(result.replacementSymbol);
                            }
                        }
                        
                        // Only rename if the name actually changed
                        if (newName !== file.basename) {
                            // Add extension back
                            const newPath = file.parent?.path 
                                ? `${file.parent.path}/${newName}${file.extension ? '.' + file.extension : ''}` 
                                : `${newName}${file.extension ? '.' + file.extension : ''}`;
                            
                            // Use Obsidian's rename method to update links
                            await this.app.fileManager.renameFile(file, newPath);
                            processedCount++;
                        }
                    } catch (error) {
                        console.error(`Error renaming file ${file.path}:`, error);
                        errorCount++;
                    }
                }
                
                // Show results
                if (errorCount > 0) {
                    new Notice(`Renamed ${processedCount} files. Encountered ${errorCount} errors.`);
                } else {
                    new Notice(`Successfully renamed ${processedCount} files.`);
                }
            }
        });

        // Add Rename with Extensions command
        this.addCommand({
            id: 'rename-with-extensions',
            name: 'Rename file and its extension variants',
            checkCallback: (checking: boolean) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile) {
                    if (!checking) {
                        const modal = new RenameModal(this.app, activeFile, async (newName: string) => {
                            await this.renameFileWithExtensions(activeFile, newName);
                        });
                        modal.open();
                    }
                    return true;
                }
                return false;
            }
        });

        // Add Reveal in Folgezettel Browser command
        this.addCommand({
            id: 'reveal-in-folgezettel-browser',
            name: 'Reveal in Folgezettel Browser',
            checkCallback: (checking: boolean) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (!activeFile) return false;
                
                if (checking) return true;
                
                this.revealFileInFolgezettelBrowser(activeFile);
                return true;
            }
        });

        // Add Copy all descendants as context command
        this.addCommand({
            id: 'copy-descendants-as-context',
            name: 'Copy all descendants as context',
            checkCallback: (checking: boolean) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (!activeFile) return false;
                
                const graph = this.getActiveGraph();
                const node = graph.nodes.get(activeFile.path);
                if (!node || !node.id) return false;
                
                if (checking) return true;
                
                this.copyDescendantsAsContext(activeFile);
                return true;
            }
        });

        // This adds a settings tab so the user can configure various aspects of the plugin
        this.addSettingTab(new MMSSettingTab(this.app, this));

    }

    onunload() {
        // Clean up views
        console.log(`[MMS] Cleaning up ${this.views.length} Folgezettel Browser views`);
        
        // Make a copy of the views array since we'll be modifying it during iteration
        const viewsToClean = [...this.views];
        
        for (const view of viewsToClean) {
            if (view && view.leaf) {
                console.log('[MMS] Detaching view:', view.getDisplayText());
                view.leaf.detach();
            }
        }
        
        this.views = [];
        
        // Shut down all Marimo servers
        this.shutdownAllMarimoServers();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        console.log('Loaded settings:', this.settings);
        // Apply font size setting
        this.updateFolgezettelBrowserFontSize();
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    updateFolgezettelBrowserFontSize() {
        // Update CSS custom property for all Folgezettel Browser views
        document.documentElement.style.setProperty('--mms-browser-font-size', `${this.settings.folgezettelBrowserFontSize}px`);
    }

    async activateView() {
        const { workspace } = this.app;

        // First check if there are any existing leaves
        const existingLeaves = workspace.getLeavesOfType('folgezettel-browser');
        
        // If there are multiple leaves, keep only the first one and detach others
        if (existingLeaves.length > 1) {
            console.log(`[MMS] Found ${existingLeaves.length} Folgezettel Browser views, cleaning up duplicates`);
            // Keep the first leaf and detach others
            for (let i = 1; i < existingLeaves.length; i++) {
                existingLeaves[i].detach();
            }
        }
        
        // Now get the leaf (either the single existing one, or the first one we kept)
        let leaf = workspace.getLeavesOfType('folgezettel-browser')[0];
        if (!leaf) {
            console.log('[MMS] No Folgezettel Browser view found, creating new one');
            const newLeaf = workspace.getLeftLeaf(false);
            if (!newLeaf) {
                throw new Error('Could not create leaf for folgezettel-browser');
            }
            await newLeaf.setViewState({ type: 'folgezettel-browser' });
            leaf = newLeaf;
        }

        workspace.revealLeaf(leaf);
        
        // Return the active view
        return this.views.find(view => view.leaf === leaf) || this.views[0];
    }

    // Method to refresh all file browser views while preserving state
    private refreshViews() {
        this.views.forEach(view => {
            if (view) {
                view.refreshPreservingState();
            }
        });
    }

    // Method to update the central graph and notify subscribers
    private updateGraph() {
        const files = this.app.vault.getFiles();
        const folders = this.app.vault.getAllLoadedFiles().filter(f => f instanceof TFolder) as TFolder[];
        const items = [...files, ...folders];
        const newGraph = buildFileGraph(items, this.app);
        this.fileGraph = newGraph;
        
        // Notify all subscribers of the new graph
        this.graphUpdateCallbacks.forEach(callback => callback(newGraph));
    }

    // Method for views to subscribe to graph updates
    public subscribeToGraphUpdates(callback: (graph: FileGraph) => void) {
        this.graphUpdateCallbacks.add(callback);
        // Initial callback with current graph
        if (this.fileGraph) {
            callback(this.fileGraph);
        }
    }

    // Method for views to unsubscribe from graph updates
    public unsubscribeFromGraphUpdates(callback: (graph: FileGraph) => void) {
        this.graphUpdateCallbacks.delete(callback);
    }

    public getActiveGraph(): FileGraph {
        if (!this.fileGraph) {
            this.updateGraph();
        }
        return this.fileGraph!;
    }

    // Method to wait for graph update to complete
    private async waitForGraphUpdate(timeout = 2000): Promise<void> {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error('Timeout waiting for graph update'));
            }, timeout);

            const callback = (graph: FileGraph) => {
                clearTimeout(timeoutId);
                this.unsubscribeFromGraphUpdates(callback);
                resolve();
            };

            this.subscribeToGraphUpdates(callback);
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

    async createFollowUpNote(item: TAbstractFile) {
        try {
            const graph = this.getActiveGraph();

            // Get parent node from graph
            const parentPath = item.path;
            const parentNode = graph.nodes.get(parentPath);
            if (!parentNode || !parentNode.id) {
                new Notice('Parent must have a valid Folgezettel ID');
                return;
            }

            // Show modal to get note name and type
            const modal = new FollowUpModal(this.app);
            const result = await modal.openAndGetValue();
            if (!result) return; // User cancelled

            // Get ID based on note type
            let newId: string;
            if (result.type === 'searching' || result.type === 'marimo') {
                // For searching and marimo notes, get next available child ID
                newId = getNextAvailableChildId(parentPath, graph);
                if (!newId) {
                    new Notice('Could not generate child ID');
                    return;
                }
            } else {
                // For mapping and planning notes, use parent's ID with appropriate suffix
                newId = result.type === 'mapping' ? `${parentNode.id}%` : `${parentNode.id}&`;
            }

            // Create the new file with appropriate extension
            const extension = result.type === 'marimo' ? '.py' : '.md';
            const newFileName = `${newId} ${result.name}${extension}`;

            // Get parent folder path
            // If item is a folder, create the file inside it
            // If item is a file, create the file in the same directory
            const parentFolder = item instanceof TFolder ? item.path : (item.parent?.path || '');
            const newFilePath = parentFolder ? `${parentFolder}/${newFileName}` : newFileName;

            // Create file with appropriate initial content
            let initialContent = '';
            if (result.type === 'marimo') {
                //  initialContent = `# %% [${parentNode.id}]\n# Follow-up to ${parentNode.id}\n\n`;
            }

            await this.app.vault.create(newFilePath, initialContent);
            
            // Open the new file
            const newFile = this.app.vault.getAbstractFileByPath(newFilePath);
            if (newFile instanceof TFile) {
                await this.app.workspace.getLeaf('tab').openFile(newFile);
            }

        } catch (error) {
            console.error('Error creating follow up note:', error);
            new Notice(`Error creating follow up note: ${error.message}`);
        }
    }

    async copyDescendantsAsContext(activeFile: TFile) {
        try {
            const graph = this.getActiveGraph();
            const node = graph.nodes.get(activeFile.path);
            
            if (!node || !node.id) {
                new Notice('File must have a valid Folgezettel ID');
                return;
            }

            // Build the markdown content
            const content = await this.buildDescendantMarkdown(activeFile.path, 1);
            
            // Copy to clipboard
            await navigator.clipboard.writeText(content);
            
            new Notice('Descendants copied to clipboard');
        } catch (error) {
            console.error('Error copying descendants to clipboard:', error);
            new Notice(`Error copying to clipboard: ${error.message}`);
        }
    }

    private async buildDescendantMarkdown(path: string, depth: number): Promise<string> {
        const graph = this.getActiveGraph();
        const node = graph.nodes.get(path);
        
        if (!node) {
            return '';
        }

        let markdown = '';
        
        // Create heading based on depth (max 6 levels)
        const headingLevel = Math.min(depth, 6);
        const heading = '#'.repeat(headingLevel);
        
        // Build the heading with ID and name
        const headingText = node.id ? 
            `${node.id}${node.name ? ' ' + node.name : ''}` : 
            (node.name || path.split('/').pop() || 'Unnamed');
        
        markdown += `${heading} ${headingText}\n`;
        
        // Add file content if not a surrogate node
        if (!node.isSurrogate && node.paths && node.paths.size > 0) {
            try {
                // Prefer .md file if available
                let filePath: string | undefined;
                if (node.extensions.has('md')) {
                    filePath = Array.from(node.paths).find(p => p.endsWith('.md'));
                }
                if (!filePath) {
                    filePath = Array.from(node.paths)[0];
                }
                
                if (filePath) {
                    const file = this.app.vault.getAbstractFileByPath(filePath);
                    if (file instanceof TFile) {
                        const content = await this.app.vault.read(file);
                        markdown += content + '\n\n';
                    }
                }
            } catch (error) {
                console.error(`Error reading file ${path}:`, error);
                markdown += '[Error reading file content]\n\n';
            }
        } else if (node.isSurrogate) {
            markdown += '[Surrogate node - no content]\n\n';
        }
        
        // Process children recursively
        const children = graph.edges.get(path);
        if (children && children.size > 0) {
            // Sort children by their ID for consistent ordering
            const sortedChildren = Array.from(children).sort((a, b) => {
                const nodeA = graph.nodes.get(a);
                const nodeB = graph.nodes.get(b);
                if (!nodeA || !nodeB) return 0;
                
                // Sort by ID if available
                if (nodeA.id && nodeB.id) {
                    return nodeA.id.localeCompare(nodeB.id);
                }
                
                // Fall back to path
                return a.localeCompare(b);
            });
            
            for (const childPath of sortedChildren) {
                if (childPath !== '/') { // Skip root node
                    const childMarkdown = await this.buildDescendantMarkdown(childPath, depth + 1);
                    markdown += childMarkdown;
                }
            }
        }
        
        return markdown;
    }

    async openMarimoNotebook(file: TFile): Promise<void> {
        // Check if we're on mobile - Marimo is desktop-only
        if (isMobileApp()) {
            new Notice('Marimo notebooks are not supported on mobile devices');
            return;
        }
        
        try {
            // Generate random port and password
            const port = generateRandomPort();
            const password = generateRandomPassword();
            
            // Get the absolute path
            const filePath = getPlatformAppropriateFilePath(file.path, this.app);

            // Replace placeholders in command
            const command = this.settings.marimoLocalCommand
                .replace('$FILEPATH', `"${filePath}"`)
                .replace('$PORT', port.toString())
                .replace('$PASSWORD', password);

            console.log('Running Marimo command:', command);

            // Run the command using our cross-platform utility
            let process: any;
            await executeCommand(
                command, 
                this.app,
                file.path,
                undefined // No mobile alternative since we already checked above
            ).catch(error => {
                console.error('Error running Marimo:', error);
                new Notice(`Error running Marimo: ${error.message}`);
                this.marimoInstances.delete(file.path);
                throw error;
            });

            // Store the instance information
            this.marimoInstances.set(file.path, {
                port,
                password,
                process
            });

            // Wait a bit for the server to start
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Show modal with link to notebook
            const url = `http://localhost:${port}/?access_token=${password}`;
            console.log('Opening Marimo URL:', url);
            
            new MarimoLinkModal(this.app, url, file.basename).open();

        } catch (error) {
            console.error('Error opening Marimo notebook:', error);
            new Notice(`Error opening Marimo notebook: ${error.message}`);
        }
    }

    async openRemoteMarimoNotebook(file: TFile, node: GraphNode): Promise<void> {
        // Check if we're on mobile - Marimo is desktop-only
        if (isMobileApp()) {
            new Notice('Remote Marimo notebooks are not supported on mobile devices');
            return;
        }
        
        try {
            // Check if remote settings are configured
            if (!this.settings.marimoRemoteHost || !this.settings.marimoRemoteUser || !this.settings.marimoRemoteKeyPath) {
                new Notice('Remote notebook settings not configured. Please configure in settings.');
                return;
            }

            // Generate random port and password
            const localPort = generateRandomPort();
            const remotePort = generateRandomPort();
            const password = generateRandomPassword();
            
            // Get the absolute path from the vault adapter
            const vaultPath = (this.app.vault.adapter as any).basePath;
            const localPath = require('path').resolve(vaultPath, node.path);
            
            let remotePath: string;
            if (this.settings.marimoRemoteSync) {
                // Create a safe remote filename by replacing spaces with underscores
                const safeRemoteFilename = file.name.replace(/\s+/g, '_');
                remotePath = `/tmp/${safeRemoteFilename}`;
            } else {
                // Use the remote vault path and translate the local path
                if (!this.settings.marimoRemoteVaultPath) {
                    new Notice('Remote vault path not configured. Please configure in settings.');
                    return;
                }
                // Get the relative path from the vault root
                const relativePath = file.path;
                remotePath = require('path').posix.join(this.settings.marimoRemoteVaultPath, relativePath);
            }
            
            // Escape quotes in paths
            const escapedLocalPath = localPath.replace(/(['"])/g, '\\$1');
            const escapedKeyPath = this.settings.marimoRemoteKeyPath.replace(/(['"])/g, '\\$1');
            
            if (this.settings.marimoRemoteSync) {
                // Build scp command with escaped paths
                const scpCommand = `scp -i "${escapedKeyPath}" "${escapedLocalPath}" ${this.settings.marimoRemoteUser}@${this.settings.marimoRemoteHost}:${remotePath}`;
                
                console.log('Copying file to remote server:', scpCommand);
                
                // Run scp command
                const { exec } = require('child_process');
                await new Promise<void>((resolve, reject) => {
                    exec(scpCommand, (error: any) => {
                        if (error) {
                            reject(error);
                        } else {
                            resolve();
                        }
                    });
                });
            }

            // Replace placeholders in command
            const remoteCommand = this.settings.marimoRemoteCommand
                .replace('$FILEPATH', `"${remotePath}"`)
                .replace('$PORT', remotePort.toString())
                .replace('$PASSWORD', password);

            // Create the SSH command with port forwarding and escaped paths
            // Source shell initialization files to ensure PATH is set correctly
            const sshCommand = `ssh -i "${escapedKeyPath}" -L ${localPort}:localhost:${remotePort} ${this.settings.marimoRemoteUser}@${this.settings.marimoRemoteHost} 'source ~/.zshrc 2>/dev/null || source ~/.bashrc 2>/dev/null; source ~/.profile 2>/dev/null; ${remoteCommand}'`;
            
            console.log('Running remote command:', sshCommand);

            // Run the SSH command
            const { exec } = require('child_process');
            const process = exec(sshCommand, (error: any) => {
                if (error) {
                    console.error('Error running remote Marimo:', error);
                    new Notice(`Error running remote Marimo: ${error.message}`);
                    this.marimoInstances.delete(file.path);
                }
            });

            let syncInterval: NodeJS.Timeout | undefined;
            
            if (this.settings.marimoRemoteSync) {
                // Function to sync files in both directions
                const syncFiles = async () => {
                    const instance = this.marimoInstances.get(file.path);
                    if (!instance) return;

                    const now = Date.now();
                    // Only sync if more than 1 second has passed since last sync
                    if (instance.lastSyncTime && now - instance.lastSyncTime < 1000) {
                        return;
                    }

                    try {
                        // First, check if remote file is newer
                        const checkCommand = `ssh -i "${escapedKeyPath}" ${this.settings.marimoRemoteUser}@${this.settings.marimoRemoteHost} "stat -f %m ${remotePath}"`;
                        const remoteTimestamp = await new Promise<number>((resolve, reject) => {
                            exec(checkCommand, (error: any, stdout: string) => {
                                if (error) {
                                    reject(error);
                                } else {
                                    resolve(parseInt(stdout.trim()));
                                }
                            });
                        });

                        const localStat = require('fs').statSync(localPath);
                        
                        if (remoteTimestamp > localStat.mtimeMs / 1000) {
                            // Remote is newer, copy from remote to local
                            const pullCommand = `scp -i "${escapedKeyPath}" ${this.settings.marimoRemoteUser}@${this.settings.marimoRemoteHost}:${remotePath} "${escapedLocalPath}"`;
                            await new Promise<void>((resolve, reject) => {
                                exec(pullCommand, (error: any) => {
                                    if (error) {
                                        reject(error);
                                    } else {
                                        resolve();
                                    }
                                });
                            });
                        } else {
                            // Local is newer or same, copy to remote
                            const pushCommand = `scp -i "${escapedKeyPath}" "${escapedLocalPath}" ${this.settings.marimoRemoteUser}@${this.settings.marimoRemoteHost}:${remotePath}`;
                            await new Promise<void>((resolve, reject) => {
                                exec(pushCommand, (error: any) => {
                                    if (error) {
                                        reject(error);
                                    } else {
                                        resolve();
                                    }
                                });
                            });
                        }
                        
                        instance.lastSyncTime = now;
                    } catch (error) {
                        console.error('Error syncing files:', error);
                    }
                };

                // Set up periodic sync
                syncInterval = setInterval(syncFiles, 1000);
            }

            // Store the instance information
            this.marimoInstances.set(file.path, {
                port: localPort,
                password,
                process,
                remotePath,
                syncInterval,
                lastSyncTime: this.settings.marimoRemoteSync ? Date.now() : undefined
            });

            // Wait a bit for the server to start
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Show modal with link to notebook
            const url = `http://localhost:${localPort}/?access_token=${password}`;
            console.log('Opening Remote Marimo URL:', url);
            
            new MarimoLinkModal(this.app, url, file.basename).open();

        } catch (error) {
            console.error('Error opening remote Marimo notebook:', error);
            new Notice(`Error opening remote Marimo notebook: ${error.message}`);
        }
    }

    async executeDefaultPythonCommand(file: TFile): Promise<void> {
        try {
            const command = this.settings.fileTypeCommands['py'];
            if (!command) {
                console.log('No default Python command configured');
                return;
            }

            // Use imported utilities
            
            if (isMobileApp()) {
                // On mobile, show notification that this feature isn't available
                new Notice('External Python commands are not available on mobile devices');
                return;
            }

            // On desktop, proceed normally
            // Get the absolute path
            const filePath = getPlatformAppropriateFilePath(file.path, this.app);
            
            // Replace filepath in command
            const finalCommand = command.replace('$FILEPATH', `"${filePath}"`);
            console.log('Running default Python command:', finalCommand);

            await executeCommand(finalCommand, this.app, file.path);
        } catch (error) {
            console.error('Error executing Python command:', error);
            new Notice(`Error executing Python command: ${error.message}`);
        }
    }

    async shutdownAllMarimoServers() {
        let count = 0;
        // Iterate through all running instances
        for (const [path, instance] of this.marimoInstances) {
            if (instance.process) {
                try {
                    // Kill the process
                    instance.process.kill();
                    if (instance.watchProcess) {
                        instance.watchProcess.kill();
                    }
                    if (instance.syncInterval) {
                        clearInterval(instance.syncInterval);
                    }
                    count++;
                } catch (error) {
                    console.error(`Error shutting down Marimo server for ${path}:`, error);
                }
            }
        }
        
        // Clear the instances map
        this.marimoInstances.clear();
        
        // Show notification
        if (count > 0) {
            new Notice(`Shut down ${count} Marimo server${count === 1 ? '' : 's'}`);
        } else {
            new Notice('No active Marimo servers to shut down');
        }
    }

    async renameFileWithExtensions(file: TFile, newName: string) {
        // Get the file graph from the active view
        const activeView = this.views[0];
        if (!activeView) {
            new Notice('File browser view not found');
            return;
        }

        const fileGraph = activeView.getCurrentGraph();
        if (!fileGraph) {
            new Notice('File graph not found');
            return;
        }

        const node = fileGraph.nodes.get(file.path);
        if (!node) {
            new Notice(`Could not find file ${file.path} in the file graph`);
            return;
        }

        // Get all files with different extensions
        const filesToRename = Array.from(node.extensions).map(ext => {
            const fullPath = node.paths.values().next().value;
            const basePath = fullPath.substring(0, fullPath.lastIndexOf('/') + 1);
            const currentName = fullPath.substring(fullPath.lastIndexOf('/') + 1);
            const baseNameWithoutExt = currentName.substring(0, currentName.lastIndexOf('.'));
            return this.app.vault.getAbstractFileByPath(basePath + baseNameWithoutExt + '.' + ext);
        }).filter((f): f is TFile => f instanceof TFile);

        if (filesToRename.length === 0) {
            new Notice(`No files found to rename`);
            return;
        }

        // Rename all files
        for (const fileToRename of filesToRename) {
            const oldPath = fileToRename.path;
            const extension = fileToRename.extension;
            const newPath = oldPath.substring(0, oldPath.lastIndexOf('/') + 1) + newName + '.' + extension;
            
            try {
                await this.app.fileManager.renameFile(fileToRename, newPath);
            } catch (error) {
                new Notice(`Failed to rename ${oldPath} to ${newPath}: ${error}`);
                return;
            }
        }

        // Trigger a refresh of the file browser view
        activeView.refreshPreservingState();

        new Notice(`Successfully renamed ${filesToRename.length} files`);
    }
    
    async revealFileInFolgezettelBrowser(file: TFile) {
        // First make sure the Folgezettel Browser view is open and get the active view
        const view = await this.activateView();
        
        if (!view) {
            new Notice('Folgezettel Browser view not available');
            return;
        }
        
        // Get the file path
        const filePath = file.path;
        
        // Get the graph
        const graph = this.getActiveGraph();
        if (!graph) {
            new Notice('File graph not available');
            return;
        }
        
        // Ensure the file exists in the graph
        const node = graph.nodes.get(filePath);
        if (!node) {
            new Notice(`File ${filePath} not found in the graph`);
            return;
        }
        
        // Find all parent paths that need to be expanded
        const parentsToExpand = new Set<string>();
        
        // Traverse backward through parent nodes
        let currentPath = filePath;
        while (currentPath) {
            // Find the parent of this path
            let parent: string | null = null;
            
            for (const [parentPath, children] of graph.edges.entries()) {
                if (children.has(currentPath)) {
                    parent = parentPath;
                    break;
                }
            }
            
            // If we found a parent, add it to the set and continue up the tree
            if (parent && parent !== '/') {
                parentsToExpand.add(parent);
                currentPath = parent;
            } else {
                break;
            }
        }
        
        console.log(`[Reveal] Found ${parentsToExpand.size} parent paths to expand:`, Array.from(parentsToExpand));
        
        // Create a new expanded paths set with all parents
        const currentExpandedPaths = view.getExpandedPaths();
        const newExpandedPaths = new Set([...currentExpandedPaths, ...parentsToExpand]);
        
        console.log(`[Reveal] Setting expanded paths:`, Array.from(newExpandedPaths));
        console.log(`[Reveal] Setting selected path: ${filePath}`);
        
        // Update the view's state directly
        view.setExpandedPaths(newExpandedPaths);
        view.setSelectedPath(filePath);
        
        // Refresh the view to apply changes
        view.refreshPreservingState();
        
        // Additional logging
        console.log(`[Reveal] After refresh - Expanded paths:`, Array.from(view.getExpandedPaths()));
        console.log(`[Reveal] After refresh - Selected path: ${view.getSelectedPath()}`);
        
        // Add a small delay to ensure the DOM has updated before scrolling
        setTimeout(() => {
            // Find the selected element and scroll to it
            const selectedElement = view.containerEl.querySelector('.file-item.selected');
            if (selectedElement) {
                selectedElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                console.log('[Reveal] Scrolled to selected element');
            } else {
                console.log('[Reveal] Could not find selected element to scroll to');
            }
        }, 200);
        
        new Notice(`Revealed ${file.name} in Folgezettel Browser`);
    }
}

class MarimoLinkModal extends Modal {
    url: string;
    filename: string;

    constructor(app: App, url: string, filename: string) {
        super(app);
        this.url = url;
        this.filename = filename;
    }

    onOpen() {
        const {contentEl} = this;
        contentEl.empty();
        
        contentEl.createEl('h2', {text: 'Open Marimo Notebook'});
        
        const container = contentEl.createDiv({cls: 'marimo-link-container'});
        
        container.createEl('p', {
            text: `Click the link below to open "${this.filename}" in Marimo:`
        });

        const link = container.createEl('a', {
            text: 'Open in Marimo',
            href: this.url
        });

        // Close modal when link is clicked
        link.addEventListener('click', () => {
            this.close();
        });
    }

    onClose() {
        const {contentEl} = this;
        contentEl.empty();
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
        
        // Add a note about mobile compatibility if we're on mobile
        if (isMobileApp()) {
            const mobileInfoEl = containerEl.createEl('div', { 
                cls: 'mms-mobile-info-banner'
            });
            
            mobileInfoEl.createEl('h3', { 
                text: 'Mobile Mode Active'
            });
            
            mobileInfoEl.createEl('p', { 
                text: 'Some features are limited on mobile devices. External commands and Marimo integration are disabled.'
            });
        }

        // File Type Actions Section
        containerEl.createEl('h2', { text: 'File Type Actions' });
        containerEl.createEl('p', { text: 'Configure commands to run when clicking different file types. Leave empty to use default behavior.' });
        containerEl.createEl('p', { text: 'Use $FILEPATH in your command to insert the absolute path to the file. The path will be automatically quoted to handle spaces, so you don\'t need to add quotes around $FILEPATH. For example:' });
        containerEl.createEl('p', { text: '    code $FILEPATH', cls: 'setting-item-description' });
        containerEl.createEl('p', { text: '    open -a Preview $FILEPATH', cls: 'setting-item-description' });
        containerEl.createEl('p', { text: '    marimo edit $FILEPATH --port 2718', cls: 'setting-item-description' });

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

        // HTML Handling Section
        containerEl.createEl('h2', { text: 'HTML Handling' });
        new Setting(containerEl)
            .setName('HTML Handling')
            .setDesc('Choose how to handle HTML files')
            .addDropdown(dropdown => dropdown
                .addOption('obsidian', 'Open in Obsidian')
                .addOption('browser', 'Open in default browser')
                .setValue(this.plugin.settings.htmlBehavior)
                .onChange(async (value: 'obsidian' | 'browser') => {
                    this.plugin.settings.htmlBehavior = value;
                    await this.plugin.saveSettings();
                }));

        // Marimo Integration Section
        containerEl.createEl('h2', { text: 'Marimo Integration' });
        containerEl.createEl('p', { text: 'Configure how to handle Marimo Python notebooks. When enabled, .py files created as follow-ups will be treated as Marimo notebooks.' });

        new Setting(containerEl)
            .setName('Use Marimo')
            .setDesc('Enable Marimo integration for Python files')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useMarimo)
                .onChange(async (value) => {
                    this.plugin.settings.useMarimo = value;
                    await this.plugin.saveSettings();
                }));

        const marimoDesc = containerEl.createEl('p', { 
            text: 'Available placeholders for Marimo commands:',
            cls: 'setting-item-description'
        });
        containerEl.createEl('ul', {}).createEl('li', { 
            text: '$FILEPATH - Path to the notebook file'
        });
        containerEl.createEl('ul', {}).createEl('li', { 
            text: '$PORT - Random port number (generated each time)'
        });
        containerEl.createEl('ul', {}).createEl('li', { 
            text: '$PASSWORD - Random password (generated each time)'
        });

        new Setting(containerEl)
            .setName('Local Notebook Command')
            .setDesc('Command to run when opening a Marimo notebook locally')
            .addText(text => text
                .setPlaceholder('marimo edit $FILEPATH --port $PORT --token-password $PASSWORD')
                .setValue(this.plugin.settings.marimoLocalCommand)
                .onChange(async (value) => {
                    this.plugin.settings.marimoLocalCommand = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Remote Notebook Command')
            .setDesc('Command to run when opening a Marimo notebook remotely')
            .addText(text => text
                .setPlaceholder('Command for remote Marimo notebooks')
                .setValue(this.plugin.settings.marimoRemoteCommand)
                .onChange(async (value) => {
                    this.plugin.settings.marimoRemoteCommand = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Remote Host')
            .setDesc('Hostname or IP address of the remote server')
            .addText(text => text
                .setPlaceholder('Remote host')
                .setValue(this.plugin.settings.marimoRemoteHost)
                .onChange(async (value) => {
                    this.plugin.settings.marimoRemoteHost = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Remote User')
            .setDesc('Username for remote server authentication')
            .addText(text => text
                .setPlaceholder('Remote user')
                .setValue(this.plugin.settings.marimoRemoteUser)
                .onChange(async (value) => {
                    this.plugin.settings.marimoRemoteUser = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Remote Key Path')
            .setDesc('Path to private key for remote server authentication')
            .addText(text => text
                .setPlaceholder('Remote key path')
                .setValue(this.plugin.settings.marimoRemoteKeyPath)
                .onChange(async (value) => {
                    this.plugin.settings.marimoRemoteKeyPath = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Remote Sync')
            .setDesc('Enable bidirectional syncing of files between local and remote servers')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.marimoRemoteSync)
                .onChange(async (value) => {
                    this.plugin.settings.marimoRemoteSync = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Remote Vault Path')
            .setDesc('Path to the vault on the remote server')
            .addText(text => text
                .setPlaceholder('Remote vault path')
                .setValue(this.plugin.settings.marimoRemoteVaultPath)
                .onChange(async (value) => {
                    this.plugin.settings.marimoRemoteVaultPath = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h3', { text: 'Ignore Patterns' });
        
        const descEl = containerEl.createEl('p', { 
            text: 'Specify patterns to ignore when building the graph. One pattern per line.'
        });
        
        const examplesEl = containerEl.createEl('div', { cls: 'setting-item-description' });
        examplesEl.createEl('div', { text: 'Examples:' });
        const list = examplesEl.createEl('ul');
        [
            ['.*', 'Hidden files and directories'],
            ['__pycache__', 'Python cache directories (anywhere in path)'],
            ['*.pyc', 'Python compiled files'],
            ['.git', 'Git directory'],
            ['temp/*', 'Everything in temp directory'],
            ['*.tmp', 'All files ending in .tmp']
        ].forEach(([pattern, desc]) => {
            list.createEl('li', {
                text: `${pattern.padEnd(12)} - ${desc}`
            });
        });

        new Setting(containerEl)
            .addTextArea(text => text
                .setPlaceholder('.*\n__pycache__\n*.pyc\n.git\n.obsidian')
                .setValue(this.plugin.settings.ignorePatterns.join('\n'))
                .onChange(async (value) => {
                    this.plugin.settings.ignorePatterns = value
                        .split('\n')
                        .map(line => line.trim())
                        .filter(line => line && !line.startsWith('#'));
                    await this.plugin.saveSettings();
                }));
                
        // Add Browser Behavior section
        containerEl.createEl('h3', { text: 'Browser Behavior' });

        new Setting(containerEl)
            .setName('Auto-reveal files')
            .setDesc('Automatically reveal files in the Folgezettel Browser when opened in the editor')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoRevealFiles)
                .onChange(async (value) => {
                    this.plugin.settings.autoRevealFiles = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Font size')
            .setDesc('Font size for items in the Folgezettel Browser (in pixels)')
            .addSlider(slider => slider
                .setLimits(10, 20, 1)
                .setValue(this.plugin.settings.folgezettelBrowserFontSize)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.folgezettelBrowserFontSize = value;
                    await this.plugin.saveSettings();
                    // Update CSS custom property for all browser views
                    this.plugin.updateFolgezettelBrowserFontSize();
                }));
    }
}
