import { ItemView, TFile, TFolder, WorkspaceLeaf, Menu, TAbstractFile, Notice, App } from 'obsidian';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { buildFileGraph, FileGraph, GraphNode, isValidNodeId, getParentId } from './FileGraph';
import MMSPlugin from './main';
import { FolgemoveModal } from './FolgemoveModal';
import { RenameModal } from './RenameModal';
import { isMobileApp, getPlatformAppropriateFilePath, executeCommand, getNextAvailableChildId } from './utils';

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
            
            console.log('Main item clicked:', path);
            console.log('Node details:', JSON.stringify({
                path,
                node: graph.nodes.get(path),
                hasChildren,
                children
            }, (key, value) => {
                if (value instanceof Set) {
                    return Array.from(value);
                }
                if (key === 'paths' || key === 'extensions') {
                    return Array.from(value || []);
                }
                return value;
            }, 2));
            
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
                console.log('Node has children, toggling expansion');
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
            console.log('Node has children, toggling expansion');
            try {
                onToggle(path);
            } catch (error) {
                console.error('Error toggling expansion:', error);
                new Notice('Error toggling expansion');
            }
        } 
        // If the node has no children and is not a directory, open it on single click
        else if (!node.isDirectory && !node.isSurrogate) {
            console.log('Node has no children, opening file on single click');
            // For files with multiple extensions, prefer .md, otherwise use the first path
            if (node.extensions && node.extensions.size > 0 && node.paths && node.paths.size > 0) {
                try {
                    const mdPath = Array.from(node.paths).find(p => p && typeof p === 'string' && p.toLowerCase().endsWith('.md'));
                    console.log('Looking for preferred .md file:', mdPath);
                    
                    if (mdPath) {
                        onFileClick(mdPath);
                    } else {
                        const firstPath = Array.from(node.paths)[0];
                        if (firstPath) {
                            console.log('No .md file found, using first path:', firstPath);
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
                console.log('Creating new file for surrogate node:', node.id);
                console.log('Node path:', path);

                // Store the expansion state of the surrogate node before creating the placeholder
                const wasExpanded = expandedPaths.has(path);

                // Recursively find first non-surrogate child
                const findNonSurrogateChild = (nodePath: string, visited: Set<string> = new Set()): string | null => {
                    if (!nodePath || visited.has(nodePath)) return null; // Prevent infinite loops
                    visited.add(nodePath);

                    const childPaths = Array.from(graph.edges.get(nodePath) || []);
                    console.log('Checking children of:', nodePath, childPaths);

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

                const pathParts = actualChildPath.split('/');
                const targetDir = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : '';
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
            console.log('Node double-clicked:', path);
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
                    console.log('Looking for preferred .md file:', mdPath);
                    
                    if (mdPath) {
                        onFileClick(mdPath);
                    } else {
                        const firstPath = Array.from(node.paths)[0];
                        if (firstPath) {
                            console.log('No .md file found, using first path:', firstPath);
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
                    .onClick(() => {
                        try {
                            const file = app.vault.getAbstractFileByPath(path);
                            if (file) {
                                const modal = new FolgemoveModal(app);
                                modal.open();
                            }
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
            console.log('Extension click handler start:', ext);
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

            console.log('Node paths:', Array.from(node.paths));
            const extPath = Array.from(node.paths).find(p => p && typeof p === 'string' && p.toLowerCase().endsWith(`.${ext}`));
            console.log('Found path for extension:', extPath);
            
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
                    {hasChildren && (
                        <span className={`collapse-icon ${expanded ? 'expanded' : ''}`}>
                            ›
                        </span>
                    )}
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
                    {Array.from(graph.edges.get(path) || [])
                        .filter(childPath => childPath !== '/') // Filter out the root node
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
        console.log('[FileBrowserComponent] Received new initialExpandedPaths:', Array.from(initialExpandedPaths));
        console.log('[FileBrowserComponent] Received new initialSelectedPath:', initialSelectedPath);
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
            
            // Create a new order by removing the source and inserting at target position
            const newOrder = [...allSiblings];
            const sourceIndex = newOrder.indexOf(sourcePath);
            newOrder.splice(sourceIndex, 1); // Remove source
            
            // Find the target index
            const targetIndex = newOrder.indexOf(targetPath);
            newOrder.splice(targetIndex, 0, sourcePath); // Insert at target position
            
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
        const directRenameOperations = [];
        
        // Prepare rename operations for each changed ID
        for (const [oldId, newId] of idChanges.entries()) {
            // Find the node(s) with this ID
            for (const [nodePath, node] of graph.nodes.entries()) {
                if (node.id === oldId) {
                    // For each file in the node, prepare a rename
                    for (const path of node.paths) {
                        const file = app.vault.getAbstractFileByPath(path);
                        if (file instanceof TFile) {
                            directRenameOperations.push({
                                file,
                                oldId,
                                newId
                            });
                        }
                    }
                }
            }
        }
        
        // If there are no ID changes, we can exit early
        if (idChanges.size === 0) {
            return;
        }
        
        // Show initial notification
        new Notice(`Reordering nodes and updating their children...`);
        
        // Execute all direct sibling renames first
        for (const op of directRenameOperations) {
            // Get the file name without the ID
            const { file, oldId, newId } = op;
            const oldName = file.basename;
            
            // Replace just the ID part
            const newName = oldName.replace(oldId, newId);
            
            // Skip if name hasn't changed
            if (oldName === newName) continue;
            
            try {
                await (plugin as MMSPlugin).renameFileWithExtensions(file, newName);
            } catch (error) {
                console.error(`Failed to rename ${file.path}:`, error);
                throw error; // Re-throw to be caught by the caller
            }
        }
        
        // Now update the children of changed nodes
        // This needs to wait a moment for the file system changes to propagate
        // and the graph to update with the new parent IDs
        setTimeout(async () => {
            try {
                // Get the updated graph
                const updatedGraph = (plugin as MMSPlugin).getActiveGraph();
                
                // Collect all descendants that need renaming
                const childRenameOperations = [];
                
                // For each ID change
                for (const [oldId, newId] of idChanges.entries()) {
                    // Find all descendant IDs that start with the old parent ID
                    for (const [nodePath, node] of updatedGraph.nodes.entries()) {
                        if (!node.id) continue;
                        
                        // Check if this is a descendant of the changed node
                        if (node.id !== oldId && node.id.startsWith(oldId)) {
                            // Generate the new descendant ID by replacing the prefix
                            const newDescendantId = node.id.replace(new RegExp(`^${oldId}`), newId);
                            
                            // For each file in the node, prepare a rename
                            for (const path of node.paths) {
                                const file = app.vault.getAbstractFileByPath(path);
                                if (file instanceof TFile) {
                                    childRenameOperations.push({
                                        file,
                                        oldId: node.id,
                                        newId: newDescendantId
                                    });
                                }
                            }
                        }
                    }
                }
                
                // Execute all child renames
                if (childRenameOperations.length > 0) {
                    new Notice(`Updating ${childRenameOperations.length} child nodes...`);
                    
                    for (const op of childRenameOperations) {
                        const { file, oldId, newId } = op;
                        const oldName = file.basename;
                        const newName = oldName.replace(oldId, newId);
                        
                        if (oldName === newName) continue;
                        
                        try {
                            await (plugin as MMSPlugin).renameFileWithExtensions(file, newName);
                        } catch (error) {
                            console.error(`Failed to rename child ${file.path}:`, error);
                            // Continue with other renames even if one fails
                        }
                    }
                    
                    new Notice(`Successfully updated ${childRenameOperations.length} child nodes`);
                }
            } catch (error) {
                console.error('Error updating children:', error);
                new Notice(`Error updating children: ${error.message || 'Unknown error'}`);
            }
        }, 1000); // Wait 1 second for the graph to update
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
        
        // Analyze the structure of the original IDs to determine the pattern we should follow
        const originalIDs = [];
        for (const siblingPath of orderedSiblings) {
            const node = graph.nodes.get(siblingPath);
            if (node?.id) {
                // Remove any special suffix for pattern analysis
                originalIDs.push(node.id.replace(/[*&!@$%^#_-]$/, ''));
            }
        }
        
        // Find the last segment common to all IDs
        // This helps identify if we're dealing with level 1 nodes (e.g., 01, 02, 03)
        // or deeper level nodes (e.g., 01a01, 01a02, 01a03)
        let isFirstLevel = false;
        if (originalIDs.length > 0) {
            // If all original IDs are simple 2-digit numbers, we're at the first level
            const allFirstLevel = originalIDs.every(id => /^\d{2}$/.test(id));
            if (allFirstLevel) {
                isFirstLevel = true;
            } else {
                // Check if all IDs share the same parent
                const parentSegment = getParentId(originalIDs[0]);
                const allSameParent = originalIDs.every(id => getParentId(id) === parentSegment);
                if (allSameParent) {
                    isFirstLevel = false;
                } else {
                    // Default to treating as first level
                    isFirstLevel = true;
                }
            }
        }
        
        // Generate new IDs for each sibling
        for (let i = 0; i < orderedSiblings.length; i++) {
            const siblingPath = orderedSiblings[i];
            const siblingNode = graph.nodes.get(siblingPath);
            if (!siblingNode || !siblingNode.id) continue;
            
            // Get the old ID and any special suffix (like * for mapping nodes)
            const oldId = siblingNode.id;
            const specialSuffix = oldId.match(/[*&!@$%^#_-]$/)?.[0] || '';
            
            // Extract the core ID (without special suffix)
            const baseOldId = oldId.replace(/[*&!@$%^#_-]$/, '');
            
            let newId: string;
            
            if (isFirstLevel) {
                // First level nodes are always two-digit numbers: 01, 02, 03...
                newId = (i + 1).toString().padStart(2, '0') + specialSuffix;
            } else {
                // Get the parent segment of the ID
                const parentSegment = getParentId(baseOldId);
                if (!parentSegment) {
                    // If we can't determine parent, skip this node
                    continue;
                }
                
                // Determine whether parent ends with letter or number for alternating pattern
                const parentEndsWithLetter = /[a-zA-Z]$/.test(parentSegment);
                
                if (parentEndsWithLetter) {
                    // Parent ends with letter, children use numbers
                    // Format: 01a01, 01a02, etc.
                    const num = (i + 1).toString().padStart(2, '0');
                    newId = parentSegment + num + specialSuffix;
                } else {
                    // Parent ends with number, children use letters
                    // Format: 01a, 01b, etc.
                    const letterCode = 'a'.charCodeAt(0) + i;
                    // Handle overflow (after 'z')
                    const letter = letterCode <= 122 ? 
                        String.fromCharCode(letterCode) : 
                        `a${String.fromCharCode(96 + ((letterCode - 96) % 26))}`;
                    newId = parentSegment + letter + specialSuffix;
                }
            }
            
            // Store the mapping if ID has changed
            if (oldId !== newId) {
                idMap.set(oldId, newId);
            }
        }
        
        return idMap;
    };
    
    const handleFileClick = async (path: string) => {
        // Skip if we're dragging
        if (isDragging) return;
        
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

            if (plugin.settings.htmlBehavior === 'obsidian' || isMobileApp()) {
                // Open in Obsidian by simulating a link click
                console.log('Opening HTML file in Obsidian via link:', path);
                await app.workspace.openLinkText(file.path, '', true, { active: true });
            } else {
                // Open in default browser (desktop only)
                try {
                    const absolutePath = (app.vault.adapter as any).basePath;
                    const filePath = require('path').resolve(absolutePath, file.path);
                    const { exec } = require('child_process');
                    exec(`open "${filePath}"`, (error: any) => {
                        if (error) {
                            console.error('Error opening HTML file:', error);
                            new Notice(`Error opening HTML file: ${error.message}`);
                        }
                    });
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
                    await app.workspace.getLeaf('tab').openFile(file);
                } else {
                    await app.workspace.openLinkText(file.path, '', true, { active: true });
                }
            } else {
                // On desktop, execute the command normally
                try {
                    // Get the absolute path by combining vault path with file path
                    const absolutePath = getPlatformAppropriateFilePath(file.path, app);
                    console.log('Converting to absolute path:', absolutePath);

                    // Run the configured command with absolute path
                    const finalCommand = command.replace('$FILEPATH', `"${absolutePath}"`);
                    console.log('Running command:', finalCommand);
                    
                    await executeCommand(finalCommand, app, file.path);
                    console.log('Command executed successfully');
                } catch (error) {
                    console.error('Command error:', error);
                    new Notice(`Error running command: ${error.message}`);
                }
            }
        }
    };

    const rootChildren = React.useMemo(() => 
        Array.from(graph.edges.get('/') || []) as string[], [graph]
    );

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
            <div 
                className="file-list"
                onClick={(e) => {
                    // Only clear active extensions if clicking directly on the file-list (not on a child element)
                    if (e.target === e.currentTarget && isMobileApp()) {
                        setActiveExtensionsPath(null);
                    }
                }}
            >
                {rootChildren.map(childPath => {
                    // Skip the root node itself
                    if (childPath === '/') return null;
                    
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
