import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile, TFolder, TAbstractFile } from 'obsidian';
import { FileBrowserView } from './FileBrowserView';
import { FolgemoveModal } from './FolgemoveModal';
import { FollowUpModal } from './FollowUpModal';
import { RenameModal } from './RenameModal';
import { RenameSymbolsModal } from './RenameSymbolsModal';
import { getNextAvailableChildId, isMobileApp, executeCommand, getPlatformAppropriateFilePath, findFilesWithProblematicSymbols, getProblematicSymbols, openOrFocusFile } from './utils';
import { FileGraph, buildFileGraph, GraphNode, applyFileCreate, applyFileDelete, applyFileRename, diffGraphs } from './FileGraph';

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
    useIncrementalUpdates: boolean;
    browserRootPath: string;
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
    folgezettelBrowserFontSize: 14,
    useIncrementalUpdates: true,
    browserRootPath: ''
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
    folgemove: (file: TAbstractFile, targetPath: string) => Promise<void>;
    openMarimoNotebook: (file: TFile) => void;
    openRemoteMarimoNotebook: (file: TFile, node: GraphNode) => void;
    executeDefaultPythonCommand: (file: TFile) => void;
    renameFileWithExtensions: (file: TFile, newName: string, silent?: boolean) => Promise<void>;
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

        // Register file system event handlers. Events are queued and flushed on a
        // 100ms debounce; the flush applies them incrementally to the existing
        // graph when possible, falling back to a full rebuild otherwise.
        // Views re-render via their graph-update subscription.
        this.registerEvent(
            this.app.vault.on('create', (file) => this.queueGraphEvent({ type: 'create', file }))
        );
        this.registerEvent(
            this.app.vault.on('delete', (file) => this.queueGraphEvent({ type: 'delete', file, path: file.path }))
        );
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => this.queueGraphEvent({ type: 'rename', file, oldPath }))
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
            // Workspace restore can materialize additional saved browser leaves
            // shortly after layout-ready (they restore as deferred views), so run
            // one more dedup pass once the dust settles
            setTimeout(() => this.dedupeBrowserLeaves(), 1500);
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
        

        // Quick-open via the MMS fuzzy search (bind a hotkey in Settings -> Hotkeys)
        this.addCommand({
            id: 'search-open',
            name: 'Open file via MMS search',
            callback: async () => {
                const modal = new FolgemoveModal(this.app, 'Search for a file to open…');
                modal.open();
                const target = await modal.getResult();
                if (!target) return; // User cancelled

                if (target instanceof TFile) {
                    await openOrFocusFile(this.app, target);
                } else {
                    // Folders can't be opened in an editor — reveal in the browser instead
                    await this.revealFileInFolgezettelBrowser(target as TFile);
                }
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
        // Note: deliberately NOT detaching our leaves here — the workspace cleans
        // them up itself, and detaching in onunload destroys the user's layout on
        // every plugin update (see Obsidian plugin guidelines).
        this.views = [];

        // Shut down all Marimo servers
        this.shutdownAllMarimoServers();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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

    // Keep only the first Folgezettel Browser leaf, detach any duplicates
    private dedupeBrowserLeaves() {
        const existingLeaves = this.app.workspace.getLeavesOfType('folgezettel-browser');
        if (existingLeaves.length > 1) {
            console.log(`[MMS] Found ${existingLeaves.length} Folgezettel Browser views, cleaning up duplicates`);
            for (let i = 1; i < existingLeaves.length; i++) {
                existingLeaves[i].detach();
            }
        }
    }

    async activateView() {
        const { workspace } = this.app;

        this.dedupeBrowserLeaves();

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

    // Method for views to deregister themselves when they close, so the views
    // array doesn't accumulate dead references across open/close cycles
    public unregisterView(view: FileBrowserView) {
        this.views = this.views.filter(v => v !== view);
    }

    // Re-render browser views without a graph rebuild (e.g. after a settings
    // change that affects presentation only)
    public refreshBrowserViews() {
        this.views.forEach(view => view?.refreshPreservingState());
    }

    // ------------------------------------------------------------------
    // Graph updating: incremental application of queued vault events with
    // full rebuild as the fallback safety net
    // ------------------------------------------------------------------

    private pendingGraphEvents: Array<{ type: 'create' | 'delete' | 'rename', file: TAbstractFile, path?: string, oldPath?: string }> = [];
    private graphUpdateTimeout: NodeJS.Timeout | null = null;

    // Observability: how updates are being served (readable via eval/console)
    public graphStats = { incrementalBatches: 0, incrementalEvents: 0, fullRebuilds: 0, incrementalFallbacks: 0 };

    private queueGraphEvent(event: { type: 'create' | 'delete' | 'rename', file: TAbstractFile, path?: string, oldPath?: string }) {
        this.pendingGraphEvents.push(event);
        if (this.graphUpdateTimeout) {
            clearTimeout(this.graphUpdateTimeout);
        }
        this.graphUpdateTimeout = setTimeout(() => this.flushGraphEvents(), 100);
    }

    private flushGraphEvents() {
        const events = this.pendingGraphEvents;
        this.pendingGraphEvents = [];

        // No baseline graph yet, or incremental disabled: do a full rebuild
        if (!this.fileGraph || !this.settings.useIncrementalUpdates) {
            this.updateGraph();
            return;
        }

        try {
            for (const ev of events) {
                let handled = false;
                if (ev.type === 'create' && ev.file instanceof TFile) {
                    handled = applyFileCreate(this.fileGraph, ev.file);
                } else if (ev.type === 'delete' && ev.path && ev.file instanceof TFile) {
                    handled = applyFileDelete(this.fileGraph, ev.path, this.app);
                } else if (ev.type === 'rename' && ev.file instanceof TFile && ev.oldPath) {
                    handled = applyFileRename(this.fileGraph, ev.file, ev.oldPath, this.app);
                }
                // Folder events and anything unexpected fall back to a rebuild
                if (!handled) {
                    this.graphStats.incrementalFallbacks++;
                    this.updateGraph();
                    return;
                }
            }
            this.graphStats.incrementalBatches++;
            this.graphStats.incrementalEvents += events.length;

            // Fresh object identity (same underlying maps) so React re-renders
            this.fileGraph = { ...this.fileGraph };
            this.graphUpdateCallbacks.forEach(callback => callback(this.fileGraph!));
        } catch (error) {
            console.error('[MMS] Incremental graph update failed, doing full rebuild:', error);
            this.graphStats.incrementalFallbacks++;
            this.updateGraph();
        }
    }

    // Full rebuild of the central graph; notifies subscribers
    public updateGraph() {
        this.graphStats.fullRebuilds++;
        const files = this.app.vault.getFiles();
        const folders = this.app.vault.getAllLoadedFiles().filter(f => f instanceof TFolder) as TFolder[];
        const items = [...files, ...folders];
        const newGraph = buildFileGraph(items, this.app);
        this.fileGraph = newGraph;

        // Notify all subscribers of the new graph
        this.graphUpdateCallbacks.forEach(callback => callback(newGraph));
    }

    // Debugging aid: compare the incrementally-maintained graph against a
    // fresh rebuild. Returns a list of structural differences (empty = OK).
    public verifyGraph(): string[] {
        if (!this.fileGraph) return ['no graph built yet'];
        const files = this.app.vault.getFiles();
        const folders = this.app.vault.getAllLoadedFiles().filter(f => f instanceof TFolder) as TFolder[];
        const fresh = buildFileGraph([...files, ...folders], this.app);
        return diffGraphs(this.fileGraph, fresh);
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

    // Method to wait for the NEXT graph rebuild to complete.
    // Note: this deliberately adds the callback directly instead of going through
    // subscribeToGraphUpdates(), because that method immediately fires the callback
    // with the CURRENT graph — which made every waiter resolve instantly with stale
    // data (the root cause of Folgemove operating on pre-rename state).
    private async waitForGraphUpdate(timeout = 2000): Promise<void> {
        return new Promise((resolve, reject) => {
            const callback = () => {
                clearTimeout(timeoutId);
                this.graphUpdateCallbacks.delete(callback);
                resolve();
            };

            const timeoutId = setTimeout(() => {
                this.graphUpdateCallbacks.delete(callback);
                reject(new Error('Timeout waiting for graph update'));
            }, timeout);

            this.graphUpdateCallbacks.add(callback);
        });
    }

    // Collect the primary paths of a node and all its descendants (via graph edges)
    private getDescendantPaths(startPath: string, graph: FileGraph): Set<string> {
        const result = new Set<string>();
        const queue = [startPath];
        while (queue.length > 0) {
            const current = queue.pop()!;
            if (result.has(current)) continue;
            result.add(current);
            for (const child of graph.edges.get(current) || []) {
                queue.push(child);
            }
        }
        return result;
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

            // Refuse to move a node into itself or its own subtree — the recursive
            // child-move would otherwise chase its own tail and corrupt IDs
            const sourceNode = graph.nodes.get(source.path);
            const sourcePrimaryPath = sourceNode?.path ?? source.path;
            const subtree = this.getDescendantPaths(sourcePrimaryPath, graph);
            if (subtree.has(targetNode.path) || sourceNode === targetNode) {
                new Notice('Cannot move a note into itself or its own descendants');
                return;
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
        // Edges are keyed by a node's PRIMARY path. If sourcePath is an alias
        // (e.g. the .py variant of a .md+.py node), resolve it first — looking up
        // edges by the alias silently returned no children.
        const primaryPath = graph.nodes.get(sourcePath)?.path ?? sourcePath;
        const childPaths = graph.edges.get(primaryPath) || new Set<string>();
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
                        // First, check if remote file is newer.
                        // GNU stat (-c %Y) on Linux remotes, BSD stat (-f %m) on macOS.
                        const checkCommand = `ssh -i "${escapedKeyPath}" ${this.settings.marimoRemoteUser}@${this.settings.marimoRemoteHost} "stat -c %Y ${remotePath} 2>/dev/null || stat -f %m ${remotePath}"`;
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

    async renameFileWithExtensions(file: TFile, newName: string, silent = false) {
        // Use the central graph — this must not depend on a browser view being open
        const fileGraph = this.getActiveGraph();

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

        // Views refresh automatically via the rename events' graph rebuild
        if (!silent) {
            new Notice(`Successfully renamed ${filesToRename.length} files`);
        }
    }
    
    async revealFileInFolgezettelBrowser(file: TFile) {
        // First make sure the Folgezettel Browser view is open and get the active view
        const view = await this.activateView();
        
        if (!view) {
            new Notice('Folgezettel Browser view not available');
            return;
        }
        
        // Get the graph
        const graph = this.getActiveGraph();
        if (!graph) {
            new Notice('File graph not available');
            return;
        }

        // Ensure the file exists in the graph
        const node = graph.nodes.get(file.path);
        if (!node) {
            new Notice(`File ${file.path} not found in the graph`);
            return;
        }

        // Use the node's primary path: the tree renders (and edges are keyed by)
        // primary paths, so revealing an alias path would neither expand nor select
        const filePath = node.path;
        
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
                    // Pattern changes only take effect through a full rebuild
                    this.plugin.updateGraph();
                }));

        // Performance section
        containerEl.createEl('h3', { text: 'Performance' });

        new Setting(containerEl)
            .setName('Incremental graph updates')
            .setDesc('Apply file events to the existing graph instead of rebuilding it from scratch. Falls back to a full rebuild automatically when needed. Disable if the browser hierarchy ever looks wrong (and please report it!).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useIncrementalUpdates)
                .onChange(async (value) => {
                    this.plugin.settings.useIncrementalUpdates = value;
                    await this.plugin.saveSettings();
                }));
                
        // Add Browser Behavior section
        containerEl.createEl('h3', { text: 'Browser Behavior' });

        new Setting(containerEl)
            .setName('Root folder')
            .setDesc('Treat this folder as the root of the Folgezettel Browser (e.g. the one folder organized with folgezettel IDs). Folders without folgezettel IDs are hidden while this is set. Leave empty to browse the whole vault.')
            .addText(text => text
                .setPlaceholder('e.g. Inergamacogna')
                .setValue(this.plugin.settings.browserRootPath)
                .onChange(async (value) => {
                    this.plugin.settings.browserRootPath = value.trim().replace(/\/+$/, '');
                    await this.plugin.saveSettings();
                    this.plugin.refreshBrowserViews();
                }));

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
