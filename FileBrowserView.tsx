import { ItemView, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { buildFileGraph } from './FileGraph';

interface FileItemProps {
    path: string;
    depth: number;
    children: string[];
    graph: ReturnType<typeof buildFileGraph>;
    onToggle: (path: string) => void;
    expandedPaths: Set<string>;
    selectedPath: string | null;
    onSelect: (path: string) => void;
    onFileClick: (path: string) => void;
}

const FileItem: React.FC<FileItemProps> = ({ 
    path, 
    depth, 
    children, 
    graph, 
    onToggle,
    expandedPaths,
    selectedPath,
    onSelect,
    onFileClick
}) => {
    const node = graph.nodes.get(path);
    if (!node) return null;

    const hasChildren = children && children.length > 0;
    const expanded = expandedPaths.has(path);
    const displayName = node.id ? `${node.id} ${node.name}` : node.name;
    const isSelected = selectedPath === path;

    const handleClick = async (e: React.MouseEvent) => {
        console.log('Main item clicked:', path);
        e.stopPropagation();
        onSelect(path);
        
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
                await app.vault.create(newFilePath, '');
                console.log('Created new file:', newFilePath);
                // Open the new file in a new tab
                const file = app.vault.getAbstractFileByPath(newFilePath);
                if (file instanceof TFile) {
                    await app.workspace.getLeaf('tab').openFile(file);
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
                    className={`file-item-content ${isSelected ? 'is-selected' : ''}`}
                    onClick={handleClick}
                >
                    {hasChildren && (
                        <span className={`collapse-icon ${expanded ? 'expanded' : ''}`}>
                            {expanded ? '▼' : '▶'}
                        </span>
                    )}
                    <div className="file-name-container">
                        <span className="file-name">{displayName}</span>
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
            {expanded && hasChildren && children.map(childPath => {
                const childNode = graph.nodes.get(childPath);
                if (!childNode) return null;
                
                const grandchildren = Array.from(graph.edges.get(childPath) || new Set());
                
                return (
                    <FileItem
                        key={childPath}
                        path={childPath}
                        depth={depth + 1}
                        children={grandchildren}
                        graph={graph}
                        onToggle={onToggle}
                        expandedPaths={expandedPaths}
                        selectedPath={selectedPath}
                        onSelect={onSelect}
                        onFileClick={onFileClick}
                    />
                );
            })}
        </>
    );
};

interface FileBrowserComponentProps {
    files: TFile[];
    folders: TFolder[];
    app: any;
    plugin: any;
}

const FileBrowserComponent: React.FC<FileBrowserComponentProps> = ({ files, folders, app, plugin }) => {
    const [expandedPaths, setExpandedPaths] = React.useState<Set<string>>(new Set());
    const [selectedPath, setSelectedPath] = React.useState<string | null>(null);

    const graph = React.useMemo(() => buildFileGraph([...folders, ...files]), [files, folders]);

    const handleToggle = (path: string) => {
        const newExpandedPaths = new Set(expandedPaths);
        if (newExpandedPaths.has(path)) {
            newExpandedPaths.delete(path);
        } else {
            newExpandedPaths.add(path);
        }
        setExpandedPaths(newExpandedPaths);
    };

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
            // Get absolute path by combining vault path with relative path
            const vaultPath = app.vault.adapter.getBasePath();
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
        Array.from(graph.edges.get('/') || []), [graph]
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

                    const children = Array.from(graph.edges.get(childPath) || new Set());
                    
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
                            onSelect={setSelectedPath}
                            onFileClick={handleFileClick}
                        />
                    );
                })}
            </div>
        </div>
    );
};

export class FileBrowserView extends ItemView {
    private root: Root | null = null;
    private plugin: any;

    constructor(leaf: WorkspaceLeaf, plugin: any) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return 'folgezettel-browser';
    }

    getDisplayText(): string {
        return 'Folgezettel Browser';
    }

    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1];
        container.empty();
        
        const files = this.app.vault.getFiles();
        const folders = this.app.vault.getAllLoadedFiles().filter((f: any) => f instanceof TFolder);

        const reactComponent = createRoot(container);
        this.root = reactComponent;
        reactComponent.render(
            <FileBrowserComponent 
                files={files} 
                folders={folders} 
                app={this.app}
                plugin={this.plugin}
            />
        );
    }

    async onClose(): Promise<void> {
        if (this.root) {
            this.root.unmount();
        }
    }
}
