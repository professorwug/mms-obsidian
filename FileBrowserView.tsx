import { ItemView, TFile, TFolder, WorkspaceLeaf, Menu, TAbstractFile, Notice, App } from 'obsidian';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { buildFileGraph, FileGraph, GraphNode } from './FileGraph';
import MMSPlugin from './main';
import { FolgemoveModal } from './FolgemoveModal';
import { RenameModal } from './RenameModal';

interface FileTypeCommands {
    [key: string]: string;
}

interface MMSPluginSettings {
    fileTypeCommands: FileTypeCommands;
    htmlBehavior: 'obsidian' | 'browser';
    useMarimo: boolean;
    marimoRemoteCommand?: string;
    marimoRemoteHost?: string;
    marimoRemoteUser?: string;
    marimoRemoteKeyPath?: string;
}

interface IMMSPlugin {
    settings: MMSPluginSettings;
    app: App;
    createFollowUpNote: (file: TFile) => void;
    folgemove: (file: TFile, targetPath: string) => void;
    openMarimoNotebook: (file: TFile) => void;
    openRemoteMarimoNotebook: (file: TFile, node: GraphNode) => void;
    executeDefaultPythonCommand: (file: TFile) => void;
    renameFileWithExtensions: (file: TFile, newName: string) => Promise<void>;
}

interface FileItemProps {
    path: string;
    depth: number;
    children: string[];
    graph: FileGraph;
    onToggle: (path: string) => void;
    expandedPaths: Set<string>;
    selectedPath: string | null;
    selectedPaths: Set<string>;
    onSelect: (path: string, isMultiSelect: boolean) => void;
    onFileClick: (path: string) => void;
    plugin: IMMSPlugin;
    app: App;
}

const FileItem: React.FC<FileItemProps> = ({ 
    path, 
    depth, 
    children, 
    graph, 
    onToggle,
    expandedPaths,
    selectedPath,
    selectedPaths,
    onSelect,
    onFileClick,
    plugin,
    app
}) => {
    const node = graph.nodes.get(path);
    if (!node) return null;

    const hasChildren = children && children.length > 0;
    const expanded = expandedPaths.has(path);
    const displayName = node.id ? `${node.id} ${node.name}` : node.name;
    const isSelected = selectedPath === path;
    const isMultiSelected = selectedPaths.has(path);

    // Check if this node has any mapping or planning children
    const hasMappingChild = hasChildren && children.some(childPath => {
        const childNode = graph.nodes.get(childPath);
        return childNode?.nodeType === 'mapping';
    });
    const hasPlanningChild = hasChildren && children.some(childPath => {
        const childNode = graph.nodes.get(childPath);
        return childNode?.nodeType === 'planning';
    });

    const handleClick = async (e: React.MouseEvent) => {
        console.log('Main item clicked:', path);
        e.stopPropagation();
        onSelect(path, e.ctrlKey || e.metaKey);
        
        const node = graph.nodes.get(path);
        if (!node) return;

        // If it's a directory, only toggle expansion
        if (node.isDirectory) {
            console.log('Directory clicked, toggling expansion');
            if (hasChildren) {
                onToggle(path);
            }
            return;
        }

        // For surrogate nodes, create a new markdown file
        if (node.isSurrogate && node.id) {
            console.log('Creating new file for surrogate node:', node.id);
            console.log('Node path:', path);
            
            // Always expand surrogate nodes when clicked
            if (hasChildren) {
                onToggle(path);
            }

            // Store the expansion state of the surrogate node before creating the placeholder
            const wasExpanded = expandedPaths.has(path);

            // Recursively find first non-surrogate child
            const findNonSurrogateChild = (nodePath: string, visited: Set<string> = new Set()): string | null => {
                if (visited.has(nodePath)) return null; // Prevent infinite loops
                visited.add(nodePath);

                const childPaths = Array.from(graph.edges.get(nodePath) || []);
                console.log('Checking children of:', nodePath, childPaths);

                for (const childPath of childPaths) {
                    const childNode = graph.nodes.get(childPath);
                    if (!childNode) continue;

                    if (!childNode.isSurrogate) {
                        // Found a non-surrogate node, use its path
                        const actualPath = Array.from(childNode.paths)[0];
                        console.log('Found non-surrogate child:', actualPath);
                        return actualPath;
                    } else {
                        // Recursively check this surrogate's children
                        const result = findNonSurrogateChild(childPath, visited);
                        if (result) return result;
                    }
                }
                return null;
            };

            const actualChildPath = findNonSurrogateChild(path);
            if (!actualChildPath) {
                console.error('Could not find any non-surrogate children');
                new Notice('Cannot create file: no non-surrogate children found');
                return;
            }

            const targetDir = actualChildPath.split('/').slice(0, -1).join('/');
            console.log('Using directory from non-surrogate child:', targetDir);

            const newFilePath = targetDir ? `${targetDir}/${node.id} Placeholder.md` : `${node.id} Placeholder.md`;
            console.log('Creating file at:', newFilePath);
            
            try {
                await plugin.app.vault.create(newFilePath, '');
                console.log('Created new file:', newFilePath);

                // If the surrogate was expanded, expand the new placeholder file
                // We need to wait a moment for the file system event to trigger and the graph to update
                if (wasExpanded) {
                    setTimeout(() => {
                        const newExpandedPaths = new Set(expandedPaths);
                        // Remove the surrogate path
                        newExpandedPaths.delete(path);
                        // Add the new placeholder path
                        newExpandedPaths.add(newFilePath);
                        onToggle(newFilePath); // Use onToggle instead of setExpandedPaths
                    }, 100);
                }

                // Open the new file in a new tab
                const file = plugin.app.vault.getAbstractFileByPath(newFilePath);
                if (file instanceof TFile) {
                    await plugin.app.workspace.getLeaf('tab').openFile(file);
                }
            } catch (error) {
                console.error('Error creating file:', error);
                new Notice(`Error creating file: ${error.message}`);
            }
            return;
        }

        // For non-directory nodes:
        // 1. If it has children, toggle expansion
        if (hasChildren) {
            console.log('File with children clicked, toggling expansion');
            onToggle(path);
        }

        // 2. For files with multiple extensions, prefer .md, otherwise use the first path
        if (node.extensions.size > 0) {
            const mdPath = Array.from(node.paths).find(p => p.toLowerCase().endsWith('.md'));
            console.log('Looking for preferred .md file:', mdPath);
            
            if (mdPath) {
                onFileClick(mdPath);
            } else {
                const firstPath = Array.from(node.paths)[0];
                console.log('No .md file found, using first path:', firstPath);
                onFileClick(firstPath);
            }
        }
    };

    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        const menu = new Menu();
        const node = graph.nodes.get(path);

        if (!node) return;

        // Add "Create Follow-up Note" option if it's a file
        if (!node.isDirectory) {
            const file = app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                menu.addItem((item) => {
                    item
                        .setTitle("Create Follow-up Note")
                        .setIcon("file-plus")
                        .onClick(() => {
                            plugin.createFollowUpNote(file);
                        });
                });

                menu.addItem((item) => {
                    item
                        .setTitle("Rename with Extensions")
                        .setIcon("pencil")
                        .onClick(() => {
                            const modal = new RenameModal(app, file, async (newName: string) => {
                                await plugin.renameFileWithExtensions(file, newName);
                            });
                            modal.open();
                        });
                });

                // Add Python-specific options if it's a Python file
                if (path.endsWith('.py')) {
                    menu.addSeparator();

                    if (plugin.settings.useMarimo) {
                        // Add Marimo options
                        menu.addItem((item) => {
                            item
                                .setTitle("Open in Marimo")
                                .setIcon("code")
                                .onClick(async () => {
                                    await plugin.openMarimoNotebook(file);
                                });
                        });
                    }

                    // Add default Python command if configured
                    if (plugin.settings.fileTypeCommands['py']) {
                        menu.addItem((item) => {
                            item
                                .setTitle("Open in Default Editor")
                                .setIcon("edit")
                                .onClick(async () => {
                                    await plugin.executeDefaultPythonCommand(file);
                                });
                        });
                    }

                    // Add remote notebook option if configured
                    if (plugin.settings.marimoRemoteHost && plugin.settings.marimoRemoteUser && plugin.settings.marimoRemoteKeyPath) {
                        menu.addItem((item) => {
                            item
                                .setTitle("Open as Remote Notebook")
                                .setIcon("globe")
                                .onClick(async () => {
                                    await plugin.openRemoteMarimoNotebook(file, node);
                                });
                        });
                    }
                }
            }
        }

        // Add folgemove option
        menu.addSeparator();
        menu.addItem((item) => {
            item
                .setTitle("Move with Children")
                .setIcon("folder-move")
                .onClick(() => {
                    const file = app.vault.getAbstractFileByPath(path);
                    if (file) {
                        const modal = new FolgemoveModal(app);
                        modal.open();
                    }
                });
        });

        menu.showAtMouseEvent(e.nativeEvent);
    };

    const handleExtensionClick = (e: React.MouseEvent, ext: string) => {
        console.log('Extension click handler start:', ext);
        e.stopPropagation();
        e.preventDefault();
        
        const node = graph.nodes.get(path);
        if (!node) return;

        console.log('Node paths:', Array.from(node.paths));
        const extPath = Array.from(node.paths).find(p => p.toLowerCase().endsWith(`.${ext}`));
        console.log('Found path for extension:', extPath);
        
        if (extPath) {
            onFileClick(extPath);
        }
    };

    return (
        <>
            <div className={`file-item ${hasChildren ? 'has-children' : ''} ${node.isDirectory ? 'is-folder' : ''}`}>
                <div className="file-item-indent" style={{ width: `${depth * 20}px` }} />
                <div 
                    className={`file-item-content ${isSelected ? 'is-selected' : ''} ${isMultiSelected ? 'is-multi-selected' : ''} ${
                        node.nodeType ? `is-${node.nodeType}-node` : ''
                    }`}
                    onClick={handleClick}
                    onContextMenu={handleContextMenu}
                >
                    {hasChildren && (
                        <span className={`collapse-icon ${expanded ? 'expanded' : ''}`}>
                            {expanded ? '▼' : '▶'}
                        </span>
                    )}
                    <div className="file-name-container">
                        <span className="file-name">
                            {displayName}
                            {hasMappingChild && <span className="node-type-indicator mapping">#</span>}
                            {hasPlanningChild && <span className="node-type-indicator planning">&</span>}
                        </span>
                        {!node.isDirectory && node.extensions.size > 0 && (
                            <div 
                                className="file-extensions"
                                onClick={(e) => {
                                    console.log('Extensions container clicked');
                                    e.stopPropagation();
                                    e.preventDefault();
                                }}
                            >
                                {Array.from(node.extensions).sort().map(ext => (
                                    <span 
                                        key={ext} 
                                        className="file-extension"
                                        onClick={(e) => handleExtensionClick(e, ext)}
                                    >
                                        {ext}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>
            {expanded && hasChildren && (
                <div className="file-item-children">
                    {Array.from(graph.edges.get(path) || [])
                        .sort((a, b) => {
                            const nodeA = graph.nodes.get(a);
                            const nodeB = graph.nodes.get(b);
                            if (!nodeA || !nodeB) return 0;

                            // Sort by full display name (ID + name)
                            const displayNameA = nodeA.id ? `${nodeA.id} ${nodeA.name}` : nodeA.name;
                            const displayNameB = nodeB.id ? `${nodeB.id} ${nodeB.name}` : nodeB.name;
                            return displayNameA.localeCompare(displayNameB);
                        })
                        .map(childPath => {
                            const childNode = graph.nodes.get(childPath);
                            if (!childNode) return null;

                            const children = Array.from(graph.edges.get(childPath) || []) as string[];
                            
                            return (
                                <FileItem
                                    key={childPath}
                                    path={childPath}
                                    depth={depth + 1}
                                    children={children}
                                    graph={graph}
                                    onToggle={onToggle}
                                    expandedPaths={expandedPaths}
                                    selectedPath={selectedPath}
                                    selectedPaths={selectedPaths}
                                    onSelect={onSelect}
                                    onFileClick={onFileClick}
                                    plugin={plugin}
                                    app={app}
                                />
                            );
                        })}
                </div>
            )}
        </>
    );
};

interface FileBrowserComponentProps {
    files: TFile[];
    folders: TFolder[];
    app: App;
    plugin: IMMSPlugin;
    initialExpandedPaths: Set<string>;
    initialSelectedPath: string | null;
    onStateChange?: (expandedPaths: Set<string>, selectedPath: string | null, graph: FileGraph) => void;
}

const FileBrowserComponent: React.FC<FileBrowserComponentProps> = ({ 
    files, 
    folders, 
    app, 
    plugin,
    initialExpandedPaths,
    initialSelectedPath,
    onStateChange
}) => {
    const [expandedPaths, setExpandedPaths] = React.useState<Set<string>>(initialExpandedPaths);
    const [selectedPath, setSelectedPath] = React.useState<string | null>(initialSelectedPath);
    const [selectedPaths, setSelectedPaths] = React.useState<Set<string>>(new Set([initialSelectedPath].filter(Boolean) as string[]));
    const graph = (plugin as MMSPlugin).getActiveGraph();
    
    // Update state when props change
    React.useEffect(() => {
        console.log('[FileBrowserComponent] Received new initialExpandedPaths:', Array.from(initialExpandedPaths));
        console.log('[FileBrowserComponent] Received new initialSelectedPath:', initialSelectedPath);
        setExpandedPaths(initialExpandedPaths);
        setSelectedPath(initialSelectedPath);
        if (initialSelectedPath) {
            setSelectedPaths(new Set([initialSelectedPath]));
        }
    }, [initialExpandedPaths, initialSelectedPath]);

    // Notify parent of state changes
    React.useEffect(() => {
        onStateChange?.(expandedPaths, selectedPath, graph);
    }, [expandedPaths, selectedPath, graph]);

    const handleToggle = (path: string) => {
        const newExpandedPaths = new Set(expandedPaths);
        if (newExpandedPaths.has(path)) {
            newExpandedPaths.delete(path);
        } else {
            newExpandedPaths.add(path);
        }
        setExpandedPaths(newExpandedPaths);
    };

    const handleSelect = React.useCallback((path: string, isMultiSelect: boolean) => {
        if (isMultiSelect) {
            setSelectedPaths(prev => {
                const newPaths = new Set(prev);
                if (newPaths.has(path)) {
                    newPaths.delete(path);
                } else {
                    newPaths.add(path);
                }
                return newPaths;
            });
        } else {
            setSelectedPath(path);
            setSelectedPaths(new Set([path]));
        }
    }, []);

    const handleFileClick = async (path: string) => {
        console.log('File click handler called with path:', path);
        const node = graph.nodes.get(path);
        if (!node || node.isDirectory) {
            console.log('Invalid node or directory, ignoring click');
            return;
        }

        // Use the exact path that was passed in
        const extension = path.split('.').pop()?.toLowerCase();
        if (!extension) {
            console.log('No extension found');
            return;
        }

        console.log('Processing file with extension:', extension);
        const command = plugin.settings.fileTypeCommands[extension];
        console.log('Found command from settings:', command);
        
        // Ignore Python files on direct click - they must be opened via context menu
        if (extension === 'py') {
            return;
        }
        
        if (extension === 'md' || extension === 'pdf' || (!command && extension !== 'html')) {
            // Default behavior: open in Obsidian in a new tab
            console.log('Opening in Obsidian:', path);
            
            // Mark that this file is being opened from the browser
            (plugin as MMSPlugin).setFileOpenSource('browser');
            
            const file = app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                await app.workspace.getLeaf('tab').openFile(file);
            }
        } else if (extension === 'html') {
            // Handle HTML files according to settings
            const file = app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) {
                console.error('File not found:', path);
                return;
            }

            if (plugin.settings.htmlBehavior === 'obsidian') {
                // Open in Obsidian by simulating a link click
                console.log('Opening HTML file in Obsidian via link:', path);
                await app.workspace.openLinkText(file.path, '', true, { active: true });
            } else {
                // Open in default browser
                const absolutePath = (app.vault.adapter as any).basePath;
                const filePath = require('path').resolve(absolutePath, file.path);
                const { exec } = require('child_process');
                exec(`open "${filePath}"`, (error: any) => {
                    if (error) {
                        console.error('Error opening HTML file:', error);
                        new Notice(`Error opening HTML file: ${error.message}`);
                    }
                });
            }
        } else if (command) {
            // Handle other file types with custom commands
            const file = app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) {
                console.error('File not found:', path);
                return;
            }

            // Get the absolute path by combining vault path with file path
            const vaultPath = (app.vault.adapter as any).basePath;
            const absolutePath = require('path').resolve(vaultPath, file.path);
            console.log('Converting to absolute path:', absolutePath);

            // Run the configured command with absolute path
            const finalCommand = command.replace('$FILEPATH', `"${absolutePath}"`);
            console.log('Running command:', finalCommand);
            const { exec } = require('child_process');
            exec(finalCommand, (error: any) => {
                if (error) {
                    console.error('Command error:', error);
                    new Notice(`Error running command: ${error.message}`);
                } else {
                    console.log('Command executed successfully');
                }
            });
        }
    };

    const rootChildren = React.useMemo(() => 
        Array.from(graph.edges.get('/') || []) as string[], [graph]
    );

    return (
        <div 
            className="file-browser-container"
            tabIndex={0}
        >
            <div className="file-list">
                {rootChildren.map(childPath => {
                    const childNode = graph.nodes.get(childPath);
                    if (!childNode) return null;

                    const children = Array.from(graph.edges.get(childPath) || []) as string[];
                    
                    return (
                        <FileItem
                            key={childPath}
                            path={childPath}
                            depth={0}
                            children={children}
                            graph={graph}
                            onToggle={handleToggle}
                            expandedPaths={expandedPaths}
                            selectedPath={selectedPath}
                            selectedPaths={selectedPaths}
                            onSelect={handleSelect}
                            onFileClick={handleFileClick}
                            plugin={plugin}
                            app={app}
                        />
                    );
                })}
            </div>
        </div>
    );
};

export class FileBrowserView extends ItemView {
    private root: Root | null = null;
    private plugin: IMMSPlugin;
    private currentExpandedPaths: Set<string> = new Set();
    private currentSelectedPath: string | null = null;
    private currentGraph: FileGraph | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: IMMSPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return 'folgezettel-browser';
    }

    getDisplayText(): string {
        return 'Folgezettel Browser';
    }

    getIcon(): string {
        return 'list-ordered';
    }

    async refreshPreservingState() {
        const expandedPaths = this.currentExpandedPaths;
        const selectedPath = this.currentSelectedPath;
        const oldGraph = this.currentGraph;

        const files = this.app.vault.getFiles();
        const folders = this.app.vault.getAllLoadedFiles()
            .filter(f => f instanceof TFolder) as TFolder[];

        const newGraph = (this.plugin as MMSPlugin).getActiveGraph();
        
        const surrogateToPlaceholder = new Map<string, string>();
        if (oldGraph) {
            expandedPaths.forEach(path => {
                const oldNode = oldGraph.nodes.get(path);
                if (oldNode?.isSurrogate && oldNode.id) {
                    const placeholderPath = Array.from(newGraph.nodes.entries()).find(([_, node]) => 
                        !node.isSurrogate && 
                        node.path.endsWith(`${oldNode.id} Placeholder.md`)
                    )?.[0];
                    
                    if (placeholderPath) {
                        surrogateToPlaceholder.set(path, placeholderPath);
                    }
                }
            });
        }

        const updatedExpandedPaths = new Set<string>();
        expandedPaths.forEach(path => {
            const newPath = surrogateToPlaceholder.get(path) || path;
            updatedExpandedPaths.add(newPath);
        });

        let updatedSelectedPath = selectedPath;
        if (selectedPath) {
            updatedSelectedPath = surrogateToPlaceholder.get(selectedPath) || selectedPath;
        }

        this.currentExpandedPaths = updatedExpandedPaths;
        this.currentSelectedPath = updatedSelectedPath;
        this.currentGraph = newGraph;

        if (this.root) {
            this.root.render(
                <FileBrowserComponent
                    files={files}
                    folders={folders}
                    app={this.app}
                    plugin={this.plugin}
                    initialExpandedPaths={updatedExpandedPaths}
                    initialSelectedPath={updatedSelectedPath}
                    onStateChange={this.handleStateChange}
                />
            );
        }
    }

    private handleStateChange = (expandedPaths: Set<string>, selectedPath: string | null, graph: FileGraph) => {
        this.currentExpandedPaths = expandedPaths;
        this.currentSelectedPath = selectedPath;
        this.currentGraph = graph;
    };

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        
        (this.plugin as MMSPlugin).subscribeToGraphUpdates((graph) => {
            this.currentGraph = graph;
            this.refreshPreservingState();
        });

        const files = this.app.vault.getFiles();
        const folders = this.app.vault.getAllLoadedFiles()
            .filter(f => f instanceof TFolder) as TFolder[];

        this.root = createRoot(container);
        this.root.render(
            <FileBrowserComponent
                files={files}
                folders={folders}
                app={this.app}
                plugin={this.plugin}
                initialExpandedPaths={new Set()}
                initialSelectedPath={null}
                onStateChange={this.handleStateChange}
            />
        );
    }

    async onClose() {
        (this.plugin as MMSPlugin).unsubscribeFromGraphUpdates((graph) => {
            this.currentGraph = graph;
            this.refreshPreservingState();
        });

        if (this.root) {
            this.root.unmount();
            this.root = null;
        }
    }

    getCurrentGraph(): FileGraph | null {
        return this.currentGraph;
    }
    
    getExpandedPaths(): Set<string> {
        return new Set(this.currentExpandedPaths);
    }
    
    setExpandedPaths(paths: Set<string>): void {
        this.currentExpandedPaths = new Set(paths);
    }
    
    getSelectedPath(): string | null {
        return this.currentSelectedPath;
    }
    
    setSelectedPath(path: string | null): void {
        this.currentSelectedPath = path;
    }
}
