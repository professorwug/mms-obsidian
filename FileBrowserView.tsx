import { ItemView, TFile, TFolder, WorkspaceLeaf, Menu, TAbstractFile, Notice, App } from 'obsidian';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { buildFileGraph, FileGraph, GraphNode } from './FileGraph';
import MMSPlugin from './main';
import { FolgemoveModal } from './FolgemoveModal';
import { RenameModal } from './RenameModal';
import { isMobileApp, getPlatformAppropriateFilePath, executeCommand } from './utils';

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
    activeExtensionsPath: string | null;
    setActiveExtensionsPath: (path: string | null) => void;
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
    setActiveExtensionsPath
}) => {
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

    const handleClick = async (e: React.MouseEvent) => {
        try {
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

        // Add "Create Follow-up Note" option if it's a file
        if (!node.isDirectory) {
            try {
                const file = app.vault.getAbstractFileByPath(path);
                if (file instanceof TFile) {
                    menu.addItem((item) => {
                        item
                            .setTitle("Create Follow-up Note")
                            .setIcon("file-plus")
                            .onClick(() => {
                                try {
                                    plugin.createFollowUpNote(file);
                                } catch (error) {
                                    console.error('Error creating follow-up note:', error);
                                    new Notice(`Error creating follow-up note: ${error.message || 'Unknown error'}`);
                                }
                            });
                    });

                    menu.addItem((item) => {
                        item
                            .setTitle("Rename with Extensions")
                            .setIcon("pencil")
                            .onClick(() => {
                                try {
                                    const modal = new RenameModal(app, file, async (newName: string) => {
                                        try {
                                            await plugin.renameFileWithExtensions(file, newName);
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
                                        try {
                                            await plugin.openMarimoNotebook(file);
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
                                            await plugin.executeDefaultPythonCommand(file);
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
                                            await plugin.openRemoteMarimoNotebook(file, node);
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

    // Use smaller indentation on mobile
    const indentSize = isMobileApp() ? 10 : 20;
    
    return (
        <>
            <div className={`file-item ${hasChildren ? 'has-children' : ''} ${node.isDirectory ? 'is-folder' : ''}`}>
                <div className="file-item-indent" style={{ width: `${depth * indentSize}px` }} />
                <div 
                    className={`file-item-content ${isSelected ? 'is-selected' : ''} ${isMultiSelected ? 'is-multi-selected' : ''} ${
                        node.nodeType ? `is-${node.nodeType}-node` : ''
                    } ${hasChildren ? 'has-collapse-icon' : ''}`}
                    onClick={handleClick}
                    onDoubleClick={handleDoubleClick}
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
                            {hasMappingChild && <span className="node-type-indicator mapping">*</span>}
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
            {expanded && hasChildren && (
                <div className="file-item-children">
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
    const [activeExtensionsPath, setActiveExtensionsPath] = React.useState<string | null>(null);
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
