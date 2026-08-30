import { ItemView, TFile, TFolder, WorkspaceLeaf, Menu, TAbstractFile, Notice, App } from 'obsidian';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { buildFileGraph, FileGraph, GraphNode, isValidNodeId, getParentId } from './FileGraph';
import MMSPlugin from './main';
import { FolgemoveModal } from './FolgemoveModal';
import { RenameModal } from './RenameModal';
import { isMobileApp, getPlatformAppropriateFilePath, executeCommand, getNextAvailableChildId, openOrFocusFile } from './utils';

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
    createFollowUpNote: (item: TAbstractFile) => void;
    folgemove: (file: TAbstractFile, targetPath: string) => Promise<void>;
    openMarimoNotebook: (file: TFile) => void;
    openRemoteMarimoNotebook: (file: TFile, node: GraphNode) => void;
    executeDefaultPythonCommand: (file: TFile) => void;
    renameFileWithExtensions: (file: TFile, newName: string, silent?: boolean) => Promise<void>;
}

const CollapseIcon: React.FC<{ expanded: boolean }> = ({ expanded }) => (
    <span className={`collapse-icon ${expanded ? 'expanded' : ''}`} aria-hidden="true">
        <svg viewBox="0 0 8 14" focusable="false">
            <path d="M1 1 L7 7 L1 13" />
        </svg>
    </span>
);

/**
 * Children of a node as shown in the browser: excludes the root marker, and —
 * when a root folder is configured — folders without folgezettel IDs.
 */
function visibleChildren(graph: FileGraph, path: string, hideNonIdFolders: boolean): string[] {
    return Array.from(graph.edges.get(path) || []).filter(childPath => {
        if (childPath === '/') return false;
        if (!hideNonIdFolders) return true;
        const node = graph.nodes.get(childPath);
        return !(node?.isDirectory && !node.id);
    });
}

interface FileItemProps {
    path: string;
    depth: number;
    children: string[];
    graph: FileGraph;
    hideNonIdFolders: boolean;
    onToggle: (path: string) => void;
    expandedPaths: Set<string>;
    selectedPath: string | null;
    selectedPaths: Set<string>;
    onSelect: (path: string, isMultiSelect: boolean) => void;
    onFileClick: (path: string) => void;
    plugin: IMMSPlugin;
    app: App;
    activeExtensionsPath: string | null;
    setActiveExtensionsPath: (path: string | null) => void;
    // Drag and drop props
    onDragStart?: (path: string) => void;
    onDragEnd?: (path: string, targetPath: string | null) => void;
    isDragging?: boolean;
    draggingPath?: string | null;
    dragOverPath?: string | null;
    setDragOverPath?: (path: string | null) => void;
    // Ref for scrolling
    fileItemRefs?: React.MutableRefObject<Map<string, HTMLDivElement>>;
}

const FileItem: React.FC<FileItemProps> = ({
    path,
    depth,
    children,
    graph,
    hideNonIdFolders,
    onToggle,
    expandedPaths,
    selectedPath,
    selectedPaths,
    onSelect,
    onFileClick,
    plugin,
    app,
    activeExtensionsPath,
    setActiveExtensionsPath,
    // Drag and drop props
    onDragStart,
    onDragEnd,
    isDragging,
    draggingPath,
    dragOverPath,
    setDragOverPath,
    // Ref for scrolling
    fileItemRefs
}) => {
    // Create a ref for the file item element
    const itemRef = React.useRef<HTMLDivElement>(null);
    
    // Register the ref with the fileItemRefs map when the component mounts or path changes
    React.useEffect(() => {
        if (itemRef.current && fileItemRefs) {
            fileItemRefs.current.set(path, itemRef.current);
            return () => {
                fileItemRefs.current.delete(path);
            };
        }
    }, [path, fileItemRefs]);
    // Extensions are now shown based on activeExtensionsPath
    const showExtensionsOnMobile = path === activeExtensionsPath;
    const node = graph.nodes.get(path);
    if (!node) return null;

    const hasChildren = children && children.length > 0;
    const expanded = expandedPaths.has(path);
    
    // We don't need this effect anymore since we're controlling extension visibility at the parent level
    // Ensure displayName is never empty by providing a fallback
    const displayName = node.id ? 
        `${node.id}${node.name ? ' ' + node.name : ''}` : 
        (node.name || `[${path.split('/').pop() || 'Unnamed'}]`);
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

    // Handle mouse down for drag start
    const handleMouseDown = (e: React.MouseEvent) => {
        // Check if Option/Alt key is pressed
        if (e.altKey && onDragStart) {
            e.preventDefault();
            e.stopPropagation();
            onDragStart(path);
        }
    };

    const handleClick = async (e: React.MouseEvent) => {
        try {
            // Skip if we're dragging
            if (isDragging) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            
            e.stopPropagation();
            onSelect(path, e.ctrlKey || e.metaKey);
            
            const node = graph.nodes.get(path);
            if (!node) {
                console.error('Node not found in graph for path:', path);
                new Notice('Error: Node not found in graph');
                return;
            }
        
        // On mobile, toggle the active extensions path (only one can be active at a time)
        if (isMobileApp()) {
            // If this node has children, toggle expansion
            if (hasChildren) {
                try {
                    onToggle(path);
                } catch (error) {
                    console.error('Error toggling expansion:', error);
                    new Notice('Error toggling expansion');
                }
            }
            
            // Set this as the active extensions path, without toggling
            if (node.extensions && node.extensions.size > 0) {
                try {
                    setActiveExtensionsPath(path);
                } catch (error) {
                    console.error('Error setting active extensions path:', error);
                }
            }
        }
        // On desktop, just toggle expansion if there are children
        else if (hasChildren) {
            try {
                onToggle(path);
            } catch (error) {
                console.error('Error toggling expansion:', error);
                new Notice('Error toggling expansion');
            }
        } 
        // If the node has no children and is not a directory, open it on single click
        else if (!node.isDirectory && !node.isSurrogate) {
            // For files with multiple extensions, prefer .md, otherwise use the first path
            if (node.extensions && node.extensions.size > 0 && node.paths && node.paths.size > 0) {
                try {
                    const mdPath = Array.from(node.paths).find(p => p && typeof p === 'string' && p.toLowerCase().endsWith('.md'));
                    
                    if (mdPath) {
                        onFileClick(mdPath);
                    } else {
                        const firstPath = Array.from(node.paths)[0];
                        if (firstPath) {
                            onFileClick(firstPath);
                        } else {
                            console.error('No valid path found for node:', path);
                            new Notice('Error: Cannot find a valid file to open');
                        }
                    }
                } catch (error) {
                    console.error('Error opening file:', error);
                    new Notice('Error opening file: ' + (error.message || 'Unknown error'));
                }
            } else {
                console.error('Node has no extensions or paths:', node);
                new Notice('Error: The file has no valid paths');
            }
        }
        
        // For surrogate nodes, create a new markdown file
        if (node.isSurrogate && node.id && node.id.trim() !== '') {
            try {

                // Store the expansion state of the surrogate node before creating the placeholder
                const wasExpanded = expandedPaths.has(path);

                // Recursively find first non-surrogate child
                const findNonSurrogateChild = (nodePath: string, visited: Set<string> = new Set()): string | null => {
                    if (!nodePath || visited.has(nodePath)) return null; // Prevent infinite loops
                    visited.add(nodePath);

                    const childPaths = Array.from(graph.edges.get(nodePath) || []);

                    for (const childPath of childPaths) {
                        if (!childPath) continue;
                        const childNode = graph.nodes.get(childPath);
                        if (!childNode) continue;

                        if (!childNode.isSurrogate) {
                            // Found a non-surrogate node, use its path
                            const nodePaths = Array.from(childNode.paths || []);
                            if (nodePaths.length === 0) continue;
                            
                            const actualPath = nodePaths[0];
                            if (!actualPath) continue;
                            
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

                const pathParts = actualChildPath.split('/');
                const targetDir = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : '';

                const newFilePath = targetDir ? `${targetDir}/${node.id} Placeholder.md` : `${node.id} Placeholder.md`;
                
                try {
                    await plugin.app.vault.create(newFilePath, '');

                    // If the surrogate was expanded, expand the new placeholder file
                    // We need to wait a moment for the file system event to trigger and the graph to update
                    if (wasExpanded) {
                        setTimeout(() => {
                            try {
                                const newExpandedPaths = new Set(expandedPaths);
                                // Remove the surrogate path
                                newExpandedPaths.delete(path);
                                // Add the new placeholder path
                                newExpandedPaths.add(newFilePath);
                                onToggle(newFilePath); // Use onToggle instead of setExpandedPaths
                            } catch (error) {
                                console.error('Error updating expanded paths:', error);
                            }
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
            } catch (error) {
                console.error('Error handling surrogate node:', error);
                new Notice(`Error handling surrogate node: ${error.message || 'Unknown error'}`);
            }
            return;
        }
        } catch (error) {
            console.error('Unhandled error in click handler:', error);
            new Notice(`Error handling click: ${error.message || 'Unknown error'}`);
        }
    };
    
    // Add double click handler to open files
    const handleDoubleClick = async (e: React.MouseEvent) => {
        try {
            e.stopPropagation();
            
            const node = graph.nodes.get(path);
            if (!node) {
                console.error('Node not found in graph for path:', path);
                new Notice('Error: Node not found in graph');
                return;
            }
            
            if (node.isDirectory || node.isSurrogate) return;
            
            // For files with multiple extensions, prefer .md, otherwise use the first path
            if (node.extensions && node.extensions.size > 0 && node.paths && node.paths.size > 0) {
                try {
                    const mdPath = Array.from(node.paths).find(p => p && typeof p === 'string' && p.toLowerCase().endsWith('.md'));
                    
                    if (mdPath) {
                        onFileClick(mdPath);
                    } else {
                        const firstPath = Array.from(node.paths)[0];
                        if (firstPath) {
                            onFileClick(firstPath);
                        } else {
                            console.error('No valid path found for node:', path);
                            new Notice('Error: Cannot find a valid file to open');
                        }
                    }
                } catch (error) {
                    console.error('Error opening file on double-click:', error);
                    new Notice(`Error opening file: ${error.message || 'Unknown error'}`);
                }
            } else {
                console.error('Node has no extensions or paths:', node);
                new Notice('Error: The file has no valid paths');
            }
        } catch (error) {
            console.error('Unhandled error in double-click handler:', error);
            new Notice(`Error handling double-click: ${error.message || 'Unknown error'}`);
        }
    };

    const handleContextMenu = (e: React.MouseEvent) => {
        try {
            e.preventDefault();
            e.stopPropagation();

            const menu = new Menu();
            const node = graph.nodes.get(path);

            if (!node) {
                console.error('Node not found in graph for path:', path);
                new Notice('Error: Node not found in graph');
                return;
            }
            
            // Add a visible indicator of which item was right-clicked (especially helpful on mobile)
            try {
                onSelect(path, false);
            } catch (error) {
                console.error('Error selecting node:', error);
            }

        // Add "Create Follow-up Note" option if it's a file or a folder with an ID
        if (!node.isDirectory || (node.isDirectory && node.id)) {
            try {
                const abstractFile = app.vault.getAbstractFileByPath(path);
                if (abstractFile && (abstractFile instanceof TFile || (abstractFile instanceof TFolder && node.id))) {
                    menu.addItem((item) => {
                        item
                            .setTitle("Create Follow-up Note")
                            .setIcon("file-plus")
                            .onClick(() => {
                                try {
                                    plugin.createFollowUpNote(abstractFile);
                                } catch (error) {
                                    console.error('Error creating follow-up note:', error);
                                    new Notice(`Error creating follow-up note: ${error.message || 'Unknown error'}`);
                                }
                            });
                    });

                    // Only add rename with extensions for files, not folders
                    if (abstractFile instanceof TFile) {
                        menu.addItem((item) => {
                            item
                                .setTitle("Rename with Extensions")
                                .setIcon("pencil")
                                .onClick(() => {
                                    try {
                                        const modal = new RenameModal(app, abstractFile, async (newName: string) => {
                                            try {
                                                await plugin.renameFileWithExtensions(abstractFile, newName);
                                            } catch (error) {
                                                console.error('Error renaming file:', error);
                                                new Notice(`Error renaming file: ${error.message || 'Unknown error'}`);
                                            }
                                        });
                                        modal.open();
                                    } catch (error) {
                                        console.error('Error opening rename modal:', error);
                                        new Notice(`Error opening rename modal: ${error.message || 'Unknown error'}`);
                                    }
                                });
                        });
                    }

                    // Add Python-specific options if it's a Python file
                    if (abstractFile instanceof TFile && path.endsWith('.py')) {
                        menu.addSeparator();

                        if (plugin.settings.useMarimo) {
                            // Add Marimo options
                            menu.addItem((item) => {
                                item
                                    .setTitle("Open in Marimo")
                                    .setIcon("code")
                                    .onClick(async () => {
                                        try {
                                            await plugin.openMarimoNotebook(abstractFile);
                                        } catch (error) {
                                            console.error('Error opening Marimo notebook:', error);
                                            new Notice(`Error opening Marimo notebook: ${error.message || 'Unknown error'}`);
                                        }
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
                                        try {
                                            await plugin.executeDefaultPythonCommand(abstractFile);
                                        } catch (error) {
                                            console.error('Error executing Python command:', error);
                                            new Notice(`Error executing Python command: ${error.message || 'Unknown error'}`);
                                        }
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
                                        try {
                                            await plugin.openRemoteMarimoNotebook(abstractFile, node);
                                        } catch (error) {
                                            console.error('Error opening remote Marimo notebook:', error);
                                            new Notice(`Error opening remote Marimo notebook: ${error.message || 'Unknown error'}`);
                                        }
                                    });
                            });
                        }
                    }
                }
            } catch (error) {
                console.error('Error setting up file menu items:', error);
            }
        }

        // Add folgemove option
        try {
            menu.addSeparator();
            menu.addItem((item) => {
                item
                    .setTitle("Move with Children")
                    .setIcon("folder-move")
                    .onClick(async () => {
                        try {
                            const file = app.vault.getAbstractFileByPath(path);
                            if (!file) return;
                            const modal = new FolgemoveModal(app);
                            modal.open();
                            const target = await modal.getResult();
                            if (!target) return; // User cancelled
                            await plugin.folgemove(file, target.path);
                        } catch (error) {
                            console.error('Error with folgemove:', error);
                            new Notice(`Error with folgemove: ${error.message || 'Unknown error'}`);
                        }
                    });
            });

            menu.showAtMouseEvent(e.nativeEvent);
        } catch (error) {
            console.error('Error showing context menu:', error);
            new Notice(`Error showing context menu: ${error.message || 'Unknown error'}`);
        }
        } catch (error) {
            console.error('Unhandled error in context menu handler:', error);
            new Notice(`Error handling context menu: ${error.message || 'Unknown error'}`);
        }
    };

    const handleExtensionClick = (e: React.MouseEvent, ext: string) => {
        try {
            e.stopPropagation();
            e.preventDefault();
            
            const node = graph.nodes.get(path);
            if (!node) {
                console.error('Node not found in graph for path:', path);
                new Notice('Error: Node not found in graph');
                return;
            }

            if (!node.paths || node.paths.size === 0) {
                console.error('Node has no paths:', node);
                new Notice('Error: No file paths available');
                return;
            }

            const extPath = Array.from(node.paths).find(p => p && typeof p === 'string' && p.toLowerCase().endsWith(`.${ext}`));
            
            if (extPath) {
                try {
                    onFileClick(extPath);
                } catch (error) {
                    console.error('Error opening file by extension:', error);
                    new Notice(`Error opening file: ${error.message || 'Unknown error'}`);
                }
            } else {
                console.error(`No file with extension .${ext} found`);
                new Notice(`No file with extension .${ext} found`);
            }
        } catch (error) {
            console.error('Unhandled error in extension click handler:', error);
            new Notice(`Error handling extension click: ${error.message || 'Unknown error'}`);
        }
    };

    // Handle drag over events
    const handleDragOver = (e: React.DragEvent) => {
        if (isDragging && setDragOverPath && draggingPath !== path) {
            e.preventDefault();
            e.stopPropagation();
            setDragOverPath(path);
        }
    };

    // Handle drag enter events - used to highlight drop targets
    const handleDragEnter = (e: React.DragEvent) => {
        if (isDragging && setDragOverPath && draggingPath !== path) {
            e.preventDefault();
            e.stopPropagation();
            setDragOverPath(path);
        }
    };

    // Handle drop events
    const handleDrop = (e: React.DragEvent) => {
        if (isDragging && onDragEnd && draggingPath !== path) {
            e.preventDefault();
            e.stopPropagation();
            onDragEnd(draggingPath!, path);
        }
    };

    // Use smaller indentation on mobile
    const indentSize = isMobileApp() ? 10 : 20;
    
    // Determine if this is the dragging item or a drop target
    const isDraggingThis = isDragging && draggingPath === path;
    const isDropTarget = isDragging && dragOverPath === path;
    
    return (
        <>
            <div 
                className={`file-item depth-${depth} ${hasChildren ? 'has-children' : ''} ${hasChildren && expanded ? 'has-expanded-children' : ''} ${node.isDirectory ? 'is-folder' : ''} ${isDraggingThis ? 'is-dragging' : ''} ${isDropTarget ? 'is-drop-target' : ''} ${isSelected ? 'selected' : ''}`}
                style={depth > 0 ? { '--parent-indent': `${(depth - 1) * indentSize}px` } as React.CSSProperties : undefined}
                draggable={true}
                onDragOver={handleDragOver}
                onDragEnter={handleDragEnter}
                onDrop={handleDrop}
                onDragStart={(e) => {
                    if (onDragStart) {
                        e.dataTransfer.setData('text/plain', path);
                        onDragStart(path);
                    }
                }}
                onDragEnd={() => {
                    if (onDragEnd && draggingPath) {
                        onDragEnd(draggingPath, null);
                    }
                }}
                ref={itemRef}
            >
                <div className="file-item-indent" style={{ width: `${depth * indentSize}px` }} />
                <div 
                    className={`file-item-content ${isSelected ? 'is-selected' : ''} ${isMultiSelected ? 'is-multi-selected' : ''} ${
                        node.nodeType ? `is-${node.nodeType}-node` : ''
                    } ${hasChildren ? 'has-collapse-icon' : ''} ${isDraggingThis ? 'is-dragging' : ''} ${isDropTarget ? 'is-drop-target' : ''}`}
                    onClick={handleClick}
                    onMouseDown={handleMouseDown}
                    onDoubleClick={handleDoubleClick}
                    onContextMenu={handleContextMenu}
                >
                    {hasChildren && <CollapseIcon expanded={expanded} />}
                    <div className="file-name-container">
                        <span className="file-name">
                            {displayName}
                            {hasMappingChild && <span className="node-type-indicator mapping">%</span>}
                            {hasPlanningChild && <span className="node-type-indicator planning">&</span>}
                        </span>
                        {!node.isDirectory && node.extensions.size > 0 && (
                            (!isMobileApp() || showExtensionsOnMobile) && (
                                <div 
                                    className={`file-extensions ${isMobileApp() ? 'mobile-extensions' : ''}`}
                                    onClick={(e) => {
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
                            )
                        )}
                    </div>
                </div>
            </div>
            {expanded && hasChildren && !isDraggingThis && (
                <div 
                    className="file-item-children"
                    style={{ '--parent-caret-position': `${depth * indentSize + 9}px` } as React.CSSProperties}
                >
                    {visibleChildren(graph, path, hideNonIdFolders)
                        .sort((a, b) => {
                            const nodeA = graph.nodes.get(a);
                            const nodeB = graph.nodes.get(b);
                            if (!nodeA || !nodeB) return 0;

                            // Sort by full display name (ID + name)
                            const displayNameA = nodeA.id ?
                                `${nodeA.id}${nodeA.name ? ' ' + nodeA.name : ''}` :
                                (nodeA.name || `[${a.split('/').pop() || 'Unnamed'}]`);
                            const displayNameB = nodeB.id ?
                                `${nodeB.id}${nodeB.name ? ' ' + nodeB.name : ''}` :
                                (nodeB.name || `[${b.split('/').pop() || 'Unnamed'}]`);
                            return displayNameA.localeCompare(displayNameB);
                        })
                        .map(childPath => {
                            const childNode = graph.nodes.get(childPath);
                            if (!childNode) return null;

                            const children = visibleChildren(graph, childPath, hideNonIdFolders);

                            return (
                                <FileItem
                                    key={childPath}
                                    path={childPath}
                                    depth={depth + 1}
                                    children={children}
                                    graph={graph}
                                    hideNonIdFolders={hideNonIdFolders}
                                    onToggle={onToggle}
                                    expandedPaths={expandedPaths}
                                    selectedPath={selectedPath}
                                    selectedPaths={selectedPaths}
                                    onSelect={onSelect}
                                    onFileClick={onFileClick}
                                    plugin={plugin}
                                    app={app}
                                    activeExtensionsPath={activeExtensionsPath}
                                    setActiveExtensionsPath={setActiveExtensionsPath}
                                    // Pass down drag and drop props
                                    onDragStart={onDragStart}
                                    onDragEnd={onDragEnd}
                                    isDragging={isDragging}
                                    draggingPath={draggingPath}
                                    dragOverPath={dragOverPath}
                                    setDragOverPath={setDragOverPath}
                                    fileItemRefs={fileItemRefs}
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
    // Create a ref map to store references to file items
    const fileItemRefs = React.useRef<Map<string, HTMLDivElement>>(new Map());
    const [expandedPaths, setExpandedPaths] = React.useState<Set<string>>(initialExpandedPaths);
    const [selectedPath, setSelectedPath] = React.useState<string | null>(initialSelectedPath);
    const [selectedPaths, setSelectedPaths] = React.useState<Set<string>>(new Set([initialSelectedPath].filter(Boolean) as string[]));
    const [activeExtensionsPath, setActiveExtensionsPath] = React.useState<string | null>(null);
    
    // Drag and drop state
    const [isDragging, setIsDragging] = React.useState<boolean>(false);
    const [draggingPath, setDraggingPath] = React.useState<string | null>(null);
    const [dragOverPath, setDragOverPath] = React.useState<string | null>(null);
    
    // Store the graph in state to avoid retrieving it during render
    const [graph, setGraph] = React.useState<FileGraph>(() => {
        // Initial graph retrieval (only happens once during initialization)
        return (plugin as MMSPlugin).getActiveGraph();
    });

    // Store keydown handler to remove it properly
    const keydownHandlerRef = React.useRef<(e: KeyboardEvent) => void>();
    
    // Subscribe to graph updates
    React.useEffect(() => {
        const handleGraphUpdate = (updatedGraph: FileGraph) => {
            // Update the graph state when it changes
            setGraph(updatedGraph);
        };
        
        // Subscribe to graph updates
        (plugin as MMSPlugin).subscribeToGraphUpdates(handleGraphUpdate);
        
        // Clean up subscription when component unmounts
        return () => {
            (plugin as MMSPlugin).unsubscribeFromGraphUpdates(handleGraphUpdate);
        };
    }, [plugin]);
    
    // Function to scroll to the selected file
    const scrollToSelectedFile = React.useCallback((path: string | null) => {
        if (!path) return;
        
        // Get the ref for the selected file
        const element = fileItemRefs.current.get(path);
        if (element) {
            // Scroll the element into view with smooth behavior
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, []);

    // Update state when props change
    React.useEffect(() => {
        setExpandedPaths(initialExpandedPaths);
        setSelectedPath(initialSelectedPath);
        if (initialSelectedPath) {
            setSelectedPaths(new Set([initialSelectedPath]));
            
            // Add a small delay to ensure the DOM has updated before scrolling
            setTimeout(() => {
                scrollToSelectedFile(initialSelectedPath);
            }, 100);
        }
    }, [initialExpandedPaths, initialSelectedPath, scrollToSelectedFile]);

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

    // Find the parent path of a node
    const findParentPath = (childPath: string): string | null => {
        for (const [parentPath, children] of graph.edges.entries()) {
            if (children.has(childPath)) {
                return parentPath;
            }
        }
        return null;
    };

    // Get siblings of a node (nodes that share the same parent)
    const getSiblings = (path: string): string[] => {
        const parentPath = findParentPath(path);
        if (!parentPath) return [];
        
        return Array.from(graph.edges.get(parentPath) || [])
            .filter(p => p !== path && p !== '/'); // Exclude self and root node
    };

    // Handle the start of dragging
    const handleDragStart = (path: string) => {
        setIsDragging(true);
        setDraggingPath(path);
        
        // Select the dragged node
        setSelectedPath(path);
        setSelectedPaths(new Set([path]));
        
        // Show a notice to the user
        new Notice('Drag mode activated. Drag to reorder. ESC to cancel.');
        
        // Add a document-level event listener for ESC key to cancel dragging
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setIsDragging(false);
                setDraggingPath(null);
                setDragOverPath(null);
                document.removeEventListener('keydown', handleKeyDown);
                keydownHandlerRef.current = undefined;
                new Notice('Drag cancelled.');
            }
        };
        keydownHandlerRef.current = handleKeyDown;
        document.addEventListener('keydown', handleKeyDown);
    };

    // Handle the end of dragging
    const handleDragEnd = async (sourcePath: string, targetPath: string) => {
        if (!sourcePath || !targetPath) {
            setIsDragging(false);
            setDraggingPath(null);
            setDragOverPath(null);
            return;
        }
        
        // Validate that source and target nodes exist
        const sourceNode = graph.nodes.get(sourcePath);
        const targetNode = graph.nodes.get(targetPath);
        
        if (!sourceNode || !targetNode) {
            new Notice('Error: Source or target node not found in graph.');
            setIsDragging(false);
            setDraggingPath(null);
            setDragOverPath(null);
            return;
        }
        
        // Validate that both nodes have valid Folgezettel IDs
        if (!sourceNode.id || !targetNode.id) {
            new Notice('Reordering is only available for nodes with valid Folgezettel IDs.');
            setIsDragging(false);
            setDraggingPath(null);
            setDragOverPath(null);
            return;
        }
        
        // Ensure source and target have the same parent (siblings)
        const sourceParent = findParentPath(sourcePath);
        const targetParent = findParentPath(targetPath);
        
        if (!sourceParent || !targetParent || sourceParent !== targetParent) {
            new Notice('Drag and drop is only allowed between siblings.');
            setIsDragging(false);
            setDraggingPath(null);
            setDragOverPath(null);
            return;
        }
        
        // Don't allow reordering if source and target are the same
        if (sourcePath === targetPath) {
            setIsDragging(false);
            setDraggingPath(null);
            setDragOverPath(null);
            return;
        }
        
        try {
            // Get all siblings in current order
            const allSiblings = Array.from(graph.edges.get(sourceParent) || [])
                .filter(p => p !== '/') // Filter out root node
                .sort((a, b) => {
                    const nodeA = graph.nodes.get(a);
                    const nodeB = graph.nodes.get(b);
                    if (!nodeA || !nodeB) return 0;
                    
                    // Sort by ID if available
                    if (nodeA.id && nodeB.id) {
                        return nodeA.id.localeCompare(nodeB.id);
                    }
                    
                    // Fall back to display name
                    const displayNameA = nodeA.id ? 
                        `${nodeA.id}${nodeA.name ? ' ' + nodeA.name : ''}` : 
                        (nodeA.name || a);
                    const displayNameB = nodeB.id ? 
                        `${nodeB.id}${nodeB.name ? ' ' + nodeB.name : ''}` : 
                        (nodeB.name || b);
                    return displayNameA.localeCompare(displayNameB);
                });
            
            // Create a new order by inserting source at target position
            const newOrder = [...allSiblings];
            const sourceIndex = newOrder.indexOf(sourcePath);
            const targetIndex = newOrder.indexOf(targetPath);
            
            if (sourceIndex === -1 || targetIndex === -1) {
                throw new Error('Source or target path not found in siblings list');
            }
            
            // Remove source from current position
            newOrder.splice(sourceIndex, 1);
            
            // Calculate adjusted target index (account for removal if source was before target)
            const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
            
            // Insert source at the adjusted target position
            newOrder.splice(adjustedTargetIndex, 0, sourcePath);
            
            // Now reorder the IDs
            await renameSiblingsInOrder(sourceParent, newOrder);
            
            // Show notification of success
            new Notice(`Reordered ${newOrder.length} files`);
        } catch (error) {
            console.error('Error reordering files:', error);
            new Notice(`Error reordering files: ${error.message || 'Unknown error'}`);
        } finally {
            // Reset drag state
            setIsDragging(false);
            setDraggingPath(null);
            setDragOverPath(null);
            if (keydownHandlerRef.current) {
                document.removeEventListener('keydown', keydownHandlerRef.current);
                keydownHandlerRef.current = undefined;
            }
        }
    };

    // Function to rename siblings in the new order
    const renameSiblingsInOrder = async (parentPath: string, orderedSiblings: string[]) => {
        // Extract the parent node's ID
        const parentNode = graph.nodes.get(parentPath);
        if (!parentNode) {
            throw new Error('Parent node not found');
        }
        
        const parentId = parentNode.id || '';
        
        // Only proceed if we have ordered siblings and parent ID
        if (orderedSiblings.length === 0 || !parentId) {
            return;
        }
        
        // Generate new IDs for all siblings following the Folgezettel pattern
        const idChanges = generateSiblingIds(parentPath, orderedSiblings, graph);
        
        // Prepare batch of rename operations for direct siblings
        const directRenameOperations: { file: TFile, oldId: string, newId: string }[] = [];

        // Prepare batch of rename operations for ALL descendants (collect before any renames)
        const childRenameOperations: { file: TFile, oldId: string, newId: string }[] = [];

        // Walk each unique node exactly once. The nodes map contains one entry per
        // PATH, so multi-extension nodes appear multiple times — and each rename op
        // goes through renameFileWithExtensions, which renames every extension
        // variant in one call. Without dedup a .md+.py node got renamed twice (the
        // second time against already-renamed files), which is what made reordering
        // intermittently corrupt names.
        const seenNodes = new Set<GraphNode>();
        for (const node of graph.nodes.values()) {
            if (!node.id || node.isSurrogate || seenNodes.has(node)) continue;
            seenNodes.add(node);

            for (const [oldId, newId] of idChanges.entries()) {
                let newNodeId: string | null = null;
                if (node.id === oldId) {
                    newNodeId = newId;
                } else if (node.id.startsWith(oldId)) {
                    // Descendant: swap the prefix (plain string ops — IDs can end in
                    // regex metacharacters like $ or ^, so no RegExp here)
                    newNodeId = newId + node.id.slice(oldId.length);
                }
                if (newNodeId === null) continue;

                // One representative file per node is enough; renameFileWithExtensions
                // takes care of the sibling extension variants
                const file = Array.from(node.paths)
                    .map(p => app.vault.getAbstractFileByPath(p))
                    .find((f): f is TFile => f instanceof TFile);
                if (file) {
                    const target = node.id === oldId ? directRenameOperations : childRenameOperations;
                    target.push({ file, oldId: node.id, newId: newNodeId });
                }
                break; // A node can match at most one changed sibling ID
            }
        }
        
        // If there are no ID changes, we can exit early
        if (idChanges.size === 0) {
            new Notice('No reordering needed - files are already in the correct order.');
            return;
        }
        
        // Validate that all files still exist before starting (both parents and children)
        const missingFiles = [];
        const allRenameOperations = [...directRenameOperations, ...childRenameOperations];
        
        for (const op of allRenameOperations) {
            const file = app.vault.getAbstractFileByPath(op.file.path);
            if (!file) {
                missingFiles.push(op.file.path);
            }
        }
        
        if (missingFiles.length > 0) {
            throw new Error(`Cannot proceed: ${missingFiles.length} files no longer exist: ${missingFiles.join(', ')}`);
        }
        
        // Single sticky progress notice, updated in place — reorder cascades used
        // to fire a separate Notice per file, which buried the workspace in toasts
        const totalOperations = directRenameOperations.length + childRenameOperations.length;
        let completedOperations = 0;
        const progress = new Notice(`Reordering: 0/${totalOperations} files renamed…`, 0);
        const tickProgress = () => {
            completedOperations++;
            progress.setMessage(`Reordering: ${completedOperations}/${totalOperations} files renamed…`);
        };

        // Track successful renames for potential rollback
        const successfulRenames = [];
        
        // Replace the ID only when it is actually the prefix of the name — a bare
        // .replace() hit the first occurrence anywhere in the name
        const replaceIdPrefix = (name: string, oldId: string, newId: string): string =>
            name.startsWith(oldId) ? newId + name.slice(oldId.length) : name;

        // PHASE 1: Execute all direct sibling renames first
        for (const op of directRenameOperations) {
            const { file, oldId, newId } = op;
            const oldName = file.basename;
            const newName = replaceIdPrefix(oldName, oldId, newId);

            // Skip if name hasn't changed
            if (oldName === newName) { tickProgress(); continue; }

            try {
                await (plugin as MMSPlugin).renameFileWithExtensions(file, newName, true);
                successfulRenames.push({ oldPath: file.path, newName, oldName });
                tickProgress();
            } catch (error) {
                console.error(`Failed to rename ${file.path}:`, error);
                progress.hide();

                // Try to rollback successful renames
                new Notice(`Error during rename operation. Attempting to rollback...`);
                for (const rollbackOp of successfulRenames.reverse()) {
                    try {
                        // Reconstruct the renamed file's path from directory + new
                        // basename; replacing the basename substring inside the full
                        // path could hit a same-named folder segment instead
                        const lastSlash = rollbackOp.oldPath.lastIndexOf('/');
                        const dir = rollbackOp.oldPath.substring(0, lastSlash + 1);
                        const oldFileName = rollbackOp.oldPath.substring(lastSlash + 1);
                        const ext = oldFileName.substring(oldFileName.lastIndexOf('.'));
                        const fileToRollback = app.vault.getAbstractFileByPath(dir + rollbackOp.newName + ext);
                        if (fileToRollback instanceof TFile) {
                            await (plugin as MMSPlugin).renameFileWithExtensions(fileToRollback, rollbackOp.oldName);
                        }
                    } catch (rollbackError) {
                        console.error(`Failed to rollback ${rollbackOp.oldPath}:`, rollbackError);
                    }
                }

                throw error; // Re-throw to be caught by the caller
            }
        }

        // PHASE 2: Execute all child renames
        for (const op of childRenameOperations) {
            const { file, oldId, newId } = op;
            const oldName = file.basename;
            const newName = replaceIdPrefix(oldName, oldId, newId);

            if (oldName === newName) { tickProgress(); continue; }

            try {
                await (plugin as MMSPlugin).renameFileWithExtensions(file, newName, true);
                tickProgress();
            } catch (error) {
                console.error(`Failed to rename child ${file.path}:`, error);
                // Continue with other child renames even if one fails
                new Notice(`Warning: Failed to rename child file ${file.path}`);
                tickProgress();
            }
        }

        progress.hide();
    };
    
    // Generate sibling IDs following the correct Folgezettel pattern
    const generateSiblingIds = (parentPath: string, orderedSiblings: string[], graph: FileGraph): Map<string, string> => {
        // Get the parent node
        const parentNode = graph.nodes.get(parentPath);
        if (!parentNode) return new Map();
        
        // Get the parent ID (removing any special suffix like * or &)
        const parentId = (parentNode.id || '').replace(/[*&!@$%^#_-]$/, '');
        if (!parentId) return new Map();
        
        // Map to store old ID -> new ID
        const idMap = new Map<string, string>();
        
        // Determine the child ID pattern based on parent ID
        // The Folgezettel system alternates between letters and numbers at each level
        const cleanParentId = parentId.replace(/[*&!@$%^#_-]$/, '');
        
        // Determine what type of children this parent should have
        let useLetters = false;
        if (cleanParentId.length === 0) {
            // Root level: children should be numbers (01, 02, 03...)
            useLetters = false;
        } else if (cleanParentId.length === 2 && /^\d{2}$/.test(cleanParentId)) {
            // Parent is level 1 (e.g., "01"): children should be letters (01a, 01b, 01c...)
            useLetters = true;
        } else {
            // For deeper levels, check if parent ends with letter or number
            const parentEndsWithLetter = /[a-zA-Z]$/.test(cleanParentId);
            // If parent ends with letter, children use numbers; if ends with number, children use letters
            useLetters = !parentEndsWithLetter;
        }
        
        // Generate new IDs for each sibling
        for (let i = 0; i < orderedSiblings.length; i++) {
            const siblingPath = orderedSiblings[i];
            const siblingNode = graph.nodes.get(siblingPath);
            if (!siblingNode || !siblingNode.id) continue;
            
            // Get the old ID and any special suffix (like * for mapping nodes)
            const oldId = siblingNode.id;
            const specialSuffix = oldId.match(/[*&!@$%^#_-]$/)?.[0] || '';
            
            let newId: string;
            
            if (useLetters) {
                // Generate letter-based ID (a, b, c, ... z, aa, ab, ac...)
                const letter = generateLetterSequence(i);
                newId = cleanParentId + letter + specialSuffix;
            } else {
                // Generate number-based ID (01, 02, 03...)
                const num = (i + 1).toString().padStart(2, '0');
                newId = cleanParentId + num + specialSuffix;
            }
            
            // Store the mapping if ID has changed
            if (oldId !== newId) {
                idMap.set(oldId, newId);
            }
        }
        
        return idMap;
    };
    
    // Helper function to generate letter sequences (a, b, c, ... z, aa, ab, ac...)
    const generateLetterSequence = (index: number): string => {
        let result = '';
        let num = index;
        
        do {
            result = String.fromCharCode(97 + (num % 26)) + result; // 97 is 'a'
            num = Math.floor(num / 26);
        } while (num > 0);
        
        return result;
    };
    
    const handleFileClick = async (path: string) => {
        // Skip if we're dragging
        if (isDragging) return;
        
        const node = graph.nodes.get(path);
        if (!node || node.isDirectory) {
            return;
        }

        // Use the exact path that was passed in
        const extension = path.split('.').pop()?.toLowerCase();
        if (!extension) {
            return;
        }

        const command = plugin.settings.fileTypeCommands[extension];
        
        // Ignore Python files on direct click - they must be opened via context menu
        if (extension === 'py') {
            return;
        }
        
        if (extension === 'md' || extension === 'pdf' || (!command && extension !== 'html')) {
            // Default behavior: focus the file's existing tab, or open a new one

            // Mark that this file is being opened from the browser
            (plugin as MMSPlugin).setFileOpenSource('browser');

            const file = app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                await openOrFocusFile(app, file);
            }
        } else if (extension === 'html') {
            // Handle HTML files according to settings
            const file = app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) {
                console.error('File not found:', path);
                return;
            }

            if (plugin.settings.htmlBehavior === 'obsidian' || isMobileApp()) {
                // Open in Obsidian by simulating a link click
                await app.workspace.openLinkText(file.path, '', true, { active: true });
            } else {
                // Open in default browser (desktop only) — shell.openPath works on
                // every platform, unlike shelling out to the macOS-only `open`
                try {
                    const absolutePath = (app.vault.adapter as any).basePath;
                    const filePath = require('path').resolve(absolutePath, file.path);
                    const openError = await require('electron').shell.openPath(filePath);
                    if (openError) {
                        throw new Error(openError);
                    }
                } catch (error) {
                    console.error('Error opening HTML file:', error);
                    new Notice(`Unable to open in browser: ${error.message}`);
                    // Fallback to opening in Obsidian
                    await app.workspace.openLinkText(file.path, '', true, { active: true });
                }
            }
        } else if (command) {
            // Handle other file types with custom commands
            const file = app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) {
                console.error('File not found:', path);
                return;
            }

            // Use imported utility functions for platform compatibility

            if (isMobileApp()) {
                // On mobile, just open the file in Obsidian if possible
                new Notice('Custom commands are not supported on mobile. Opening file in Obsidian if possible.');
                if (file.extension === 'md') {
                    await openOrFocusFile(app, file);
                } else {
                    await app.workspace.openLinkText(file.path, '', true, { active: true });
                }
            } else {
                // On desktop, execute the command normally
                try {
                    // Get the absolute path by combining vault path with file path
                    const absolutePath = getPlatformAppropriateFilePath(file.path, app);

                    // Run the configured command with absolute path
                    const finalCommand = command.replace('$FILEPATH', `"${absolutePath}"`);
                    
                    await executeCommand(finalCommand, app, file.path);
                } catch (error) {
                    console.error('Command error:', error);
                    new Notice(`Error running command: ${error.message}`);
                }
            }
        }
    };

    // Root-folder mode: treat the configured folder as the browser root and
    // hide folders without folgezettel IDs (they're navigation noise there)
    const configuredRoot = (plugin as MMSPlugin).settings.browserRootPath?.trim().replace(/\/+$/, '');
    const rootedMode = !!(configuredRoot && graph.nodes.has(configuredRoot));
    const effectiveRoot = rootedMode ? configuredRoot : '/';

    const rootChildren = React.useMemo(() =>
        visibleChildren(graph, effectiveRoot, rootedMode)
            .sort((a, b) => {
                const nodeA = graph.nodes.get(a);
                const nodeB = graph.nodes.get(b);
                if (!nodeA || !nodeB) return 0;
                const displayNameA = nodeA.id ? `${nodeA.id} ${nodeA.name}` : nodeA.name;
                const displayNameB = nodeB.id ? `${nodeB.id} ${nodeB.name}` : nodeB.name;
                return displayNameA.localeCompare(displayNameB);
            }),
        [graph, effectiveRoot, rootedMode]
    );

    // In rooted mode, ID-less files at the root level are tucked into a
    // collapsed "Unfiled" group instead of cluttering the top of the tree
    const { idRootChildren, unfiledChildren } = React.useMemo(() => {
        if (!rootedMode) {
            return { idRootChildren: rootChildren, unfiledChildren: [] as string[] };
        }
        const withId: string[] = [];
        const unfiled: string[] = [];
        for (const childPath of rootChildren) {
            const node = graph.nodes.get(childPath);
            if (node?.id) {
                withId.push(childPath);
            } else {
                unfiled.push(childPath);
            }
        }
        return { idRootChildren: withId, unfiledChildren: unfiled };
    }, [rootChildren, rootedMode, graph]);

    const [unfiledExpanded, setUnfiledExpanded] = React.useState(false);

    // If something reveals/selects an unfiled file, open the group so the
    // selection is actually visible
    React.useEffect(() => {
        if (selectedPath && unfiledChildren.includes(selectedPath)) {
            setUnfiledExpanded(true);
        }
    }, [selectedPath, unfiledChildren]);

    // Recently edited files with folgezettel IDs (scoped to the root folder in
    // rooted mode), shown in a collapsed-by-default box above the tree
    const [recentsExpanded, setRecentsExpanded] = React.useState(false);
    const recentFiles = React.useMemo(() => {
        return app.vault.getFiles()
            .filter(f => {
                if (rootedMode && !f.path.startsWith(effectiveRoot + '/')) return false;
                const node = graph.nodes.get(f.path);
                return !!(node?.id && !node.isSurrogate);
            })
            .sort((a, b) => b.stat.mtime - a.stat.mtime)
            .slice(0, 10);
    }, [graph, rootedMode, effectiveRoot]);

    const handleRecentClick = (file: TFile) => {
        (plugin as MMSPlugin).revealFileInFolgezettelBrowser(file);
    };

    // Add mobile-specific class
    const containerClass = `file-browser-container ${isMobileApp() ? 'mobile-view' : ''}`;
    
    const handleContainerClick = (e: React.MouseEvent) => {
        // Only clear active extensions if clicking directly on the container (not on a child element)
        if (e.target === e.currentTarget && isMobileApp()) {
            setActiveExtensionsPath(null);
        }
    };
    
    return (
        <div 
            className={containerClass}
            tabIndex={0}
            onClick={handleContainerClick}
        >
            {/* Drag mode indicator banner */}
            {isDragging && (
                <div className="drag-mode-banner">
                    <div className="drag-mode-icon">🚧</div>
                    <div className="drag-mode-text">
                        <strong>Drag to reorder</strong>
                        <span className="drag-mode-hint">(Esc to cancel)</span>
                    </div>
                </div>
            )}

            {/* Recently edited folgezettel files */}
            {recentFiles.length > 0 && (
                <div className="mms-recents">
                    <div
                        className="mms-recents-header"
                        onClick={() => setRecentsExpanded(!recentsExpanded)}
                    >
                        <CollapseIcon expanded={recentsExpanded} />
                        <span className="mms-recents-title">Recent</span>
                    </div>
                    {recentsExpanded && (
                        <div className="mms-recents-list">
                            {recentFiles.map(file => {
                                const node = graph.nodes.get(file.path);
                                const label = node?.id ?
                                    `${node.id}${node.name ? ' ' + node.name : ''}` :
                                    file.basename;
                                return (
                                    <div
                                        key={file.path}
                                        className="mms-recents-item"
                                        onClick={() => handleRecentClick(file)}
                                        title={file.path}
                                    >
                                        {label}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            <div
                className="file-list"
                onClick={(e) => {
                    // Only clear active extensions if clicking directly on the file-list (not on a child element)
                    if (e.target === e.currentTarget && isMobileApp()) {
                        setActiveExtensionsPath(null);
                    }
                }}
            >
                {idRootChildren.map(childPath => {
                    const childNode = graph.nodes.get(childPath);
                    if (!childNode) return null;

                    const children = visibleChildren(graph, childPath, rootedMode);

                    return (
                        <FileItem
                            key={childPath}
                            path={childPath}
                            depth={0}
                            children={children}
                            graph={graph}
                            hideNonIdFolders={rootedMode}
                            onToggle={handleToggle}
                            expandedPaths={expandedPaths}
                            selectedPath={selectedPath}
                            selectedPaths={selectedPaths}
                            onSelect={handleSelect}
                            onFileClick={handleFileClick}
                            plugin={plugin}
                            app={app}
                            activeExtensionsPath={activeExtensionsPath}
                            setActiveExtensionsPath={setActiveExtensionsPath}
                            // Drag and drop props
                            onDragStart={handleDragStart}
                            onDragEnd={handleDragEnd}
                            isDragging={isDragging}
                            draggingPath={draggingPath}
                            dragOverPath={dragOverPath}
                            setDragOverPath={setDragOverPath}
                            // Ref for scrolling
                            fileItemRefs={fileItemRefs}
                        />
                    );
                })}

                {/* ID-less files at the root level, tucked away in rooted mode */}
                {unfiledChildren.length > 0 && (
                    <div className="mms-unfiled">
                        <div
                            className="mms-unfiled-header"
                            onClick={() => setUnfiledExpanded(!unfiledExpanded)}
                        >
                            <CollapseIcon expanded={unfiledExpanded} />
                            <span className="mms-unfiled-title">Unfiled</span>
                            <span className="mms-unfiled-count">{unfiledChildren.length}</span>
                        </div>
                        {unfiledExpanded && unfiledChildren.map(childPath => {
                            const childNode = graph.nodes.get(childPath);
                            if (!childNode) return null;

                            return (
                                <FileItem
                                    key={childPath}
                                    path={childPath}
                                    depth={1}
                                    children={visibleChildren(graph, childPath, rootedMode)}
                                    graph={graph}
                                    hideNonIdFolders={rootedMode}
                                    onToggle={handleToggle}
                                    expandedPaths={expandedPaths}
                                    selectedPath={selectedPath}
                                    selectedPaths={selectedPaths}
                                    onSelect={handleSelect}
                                    onFileClick={handleFileClick}
                                    plugin={plugin}
                                    app={app}
                                    activeExtensionsPath={activeExtensionsPath}
                                    setActiveExtensionsPath={setActiveExtensionsPath}
                                    onDragStart={handleDragStart}
                                    onDragEnd={handleDragEnd}
                                    isDragging={isDragging}
                                    draggingPath={draggingPath}
                                    dragOverPath={dragOverPath}
                                    setDragOverPath={setDragOverPath}
                                    fileItemRefs={fileItemRefs}
                                />
                            );
                        })}
                    </div>
                )}
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

    private graphUpdateHandler: ((graph: FileGraph) => void) | null = null;

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();

        this.graphUpdateHandler = (graph) => {
            this.currentGraph = graph;
            this.refreshPreservingState();
        };
        (this.plugin as MMSPlugin).subscribeToGraphUpdates(this.graphUpdateHandler);

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
        if (this.graphUpdateHandler) {
            (this.plugin as MMSPlugin).unsubscribeFromGraphUpdates(this.graphUpdateHandler);
            this.graphUpdateHandler = null;
        }

        if (this.root) {
            this.root.unmount();
            this.root = null;
        }

        (this.plugin as MMSPlugin).unregisterView(this);
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
