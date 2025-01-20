import { ItemView, TFile, TFolder, WorkspaceLeaf, Menu, TAbstractFile, Notice, App } from 'obsidian';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { buildFileGraph, FileGraph } from './FileGraph';
import MMSPlugin from './main';
import { FolgemoveModal } from './FolgemoveModal';

interface FileTypeCommands {
    [key: string]: string;
}

interface MMSPluginSettings {
    fileTypeCommands: FileTypeCommands;
}

interface IMMSPlugin {
    settings: MMSPluginSettings;
    app: App;
    createFollowUpNote: (file: TFile) => void;
    folgemove: (file: TFile, targetPath: string) => void;
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

        // Get all selected files (including the current one if it's not in the selection)
        const filesToMove = new Set(selectedPaths);
        if (!filesToMove.has(path)) {
            filesToMove.clear();
            filesToMove.add(path);
        }

        // Don't show Folgemove for surrogate nodes or if any selected item is a surrogate
        const hasSurrogate = Array.from(filesToMove).some(p => {
            const n = graph.nodes.get(p);
            return n?.isSurrogate;
        });

        if (!hasSurrogate) {
            const fileCount = filesToMove.size;
            menu.addItem((item) => {
                item
                    .setTitle(fileCount > 1 ? `Folgemove (${fileCount} files)` : "Folgemove")
                    .setIcon("arrow-right")
                    .onClick(async () => {
                        // Get all the files to move
                        const files = Array.from(filesToMove)
                            .map(p => plugin.app.vault.getAbstractFileByPath(p))
                            .filter((f): f is TFile => f instanceof TFile);

                        if (files.length > 0) {
                            const modal = new FolgemoveModal(plugin.app);
                            modal.open();
                            const targetFile = await modal.getResult();
                            if (targetFile) {
                                const targetPath = targetFile.path;
                                
                                if (!targetPath) {
                                    new Notice('Invalid target location');
                                    return;
                                }

                                // Move each file in sequence
                                for (const file of files) {
                                    await plugin.folgemove(file, targetPath);
                                }
                            }
                        }
                    });
            });
        }

        if (!node.isDirectory) {
            menu.addItem(item => 
                item
                    .setTitle("Create Follow Up Note")
                    .setIcon("plus")
                    .onClick(() => {
                        const file = plugin.app.vault.getAbstractFileByPath(path);
                        if (file instanceof TFile) {
                            plugin.createFollowUpNote(file);
                        }
                    })
            );
        }

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
    const [selectedPaths, setSelectedPaths] = React.useState<Set<string>>(new Set());
    const graph = React.useMemo(() => buildFileGraph([...folders, ...files]), [files, folders]);

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
        
        if (extension === 'md' || extension === 'pdf' || !command) {
            // Default behavior: open in Obsidian in a new tab
            console.log('Opening in Obsidian:', path);
            const file = app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                await app.workspace.getLeaf('tab').openFile(file);
            }
        } else {
            // Get the vault path from plugin
            const vaultPath = plugin.app.vault.configDir.replace('/.obsidian', '');
            const absolutePath = `${vaultPath}/${path}`;
            console.log('Converting to absolute path:', absolutePath);

            // Run the configured command with absolute path
            const finalCommand = command.replace('$FILEPATH', absolutePath);
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

    // Method to preserve and restore view state during refresh
    async refreshPreservingState() {
        // Store current state before refresh
        const expandedPaths = this.currentExpandedPaths;
        const selectedPath = this.currentSelectedPath;
        const oldGraph = this.currentGraph;

        // Get fresh file list and rebuild graph
        const files = this.app.vault.getFiles();
        const folders = this.app.vault.getAllLoadedFiles()
            .filter(f => f instanceof TFolder) as TFolder[];
        
        // Build new graph to check for surrogate->placeholder transitions
        const newGraph = buildFileGraph([...folders, ...files]);
        
        // Create a map of surrogate paths to their corresponding placeholder paths
        const surrogateToPlaceholder = new Map<string, string>();
        if (oldGraph) {
            expandedPaths.forEach(path => {
                const oldNode = oldGraph.nodes.get(path);
                if (oldNode?.isSurrogate && oldNode.id) {
                    // Look for a placeholder file with this ID in the new graph
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

        // Update expanded paths to use placeholder paths instead of surrogate paths
        const updatedExpandedPaths = new Set<string>();
        expandedPaths.forEach(path => {
            const newPath = surrogateToPlaceholder.get(path) || path;
            updatedExpandedPaths.add(newPath);
        });

        // Update selected path if it was a surrogate that's now a placeholder
        let updatedSelectedPath = selectedPath;
        if (selectedPath) {
            updatedSelectedPath = surrogateToPlaceholder.get(selectedPath) || selectedPath;
        }
        
        // Re-render with preserved state
        if (this.root) {
            this.root.render(
                <FileBrowserComponent
                    files={files}
                    folders={folders}
                    app={this.app}
                    plugin={this.plugin}
                    initialExpandedPaths={updatedExpandedPaths}
                    initialSelectedPath={updatedSelectedPath}
                    onStateChange={(expandedPaths, selectedPath, graph) => {
                        this.currentExpandedPaths = expandedPaths;
                        this.currentSelectedPath = selectedPath;
                        this.currentGraph = graph;
                    }}
                />
            );
        }
    }

    async onOpen() {
        const files = this.app.vault.getFiles();
        const folders = this.app.vault.getAllLoadedFiles()
            .filter(f => f instanceof TFolder) as TFolder[];

        this.root = createRoot(this.containerEl.children[1]);
        this.root.render(
            <FileBrowserComponent
                files={files}
                folders={folders}
                app={this.app}
                plugin={this.plugin}
                initialExpandedPaths={new Set()}
                initialSelectedPath={null}
                onStateChange={(expandedPaths, selectedPath, graph) => {
                    this.currentExpandedPaths = expandedPaths;
                    this.currentSelectedPath = selectedPath;
                    this.currentGraph = graph;
                }}
            />
        );
    }

    async onClose() {
        if (this.root) {
            this.root.unmount();
            this.root = null;
        }
    }

    // Public method to access the current graph
    public getCurrentGraph(): FileGraph | null {
        return this.currentGraph;
    }
}
