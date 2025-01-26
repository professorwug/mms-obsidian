import { TFile, TFolder, App } from 'obsidian';
import { minimatch } from 'minimatch';

interface GraphNode {
    path: string;          // Primary path (first file found)
    name: string;          // Display name (without ID if present)
    id?: string;          // Folgezettel ID if present
    nodeType?: 'mapping' | 'planning';  // Special node types
    extensions: Set<string>; // All file extensions for this node
    isDirectory: boolean;  // Is this a folder?
    isSurrogate: boolean; // Is this a surrogate node for a missing parent?
    paths: Set<string>;   // All paths associated with this node
}

export interface FileGraph {
    nodes: Map<string, GraphNode>;  // path -> node
    edges: Map<string, Set<string>>; // parent path -> set of child paths
}

export function isValidNodeId(nodeId: string): boolean {
    if (nodeId.length < 2) return false;

    // Root level must be exactly 2 digits
    if (nodeId.length === 2) {
        return /^\d{2}$/.test(nodeId);
    }

    // First two characters must be digits
    if (!/^\d{2}/.test(nodeId)) return false;

    let pos = 2;
    while (pos < nodeId.length) {
        // Must have non-digit character
        if (pos >= nodeId.length || /\d/.test(nodeId[pos])) {
            return false;
        }
        pos++;

        // Must follow letter with two digits if more than one character remains
        if (!nodeId[pos - 1].match(/\d/)) {
            if (pos <= nodeId.length - 2) {
                if (!/\d/.test(nodeId[pos]) && !/\d/.test(nodeId[pos + 1])) {
                    return false;
                }
                pos += 2;
            } else if (pos === nodeId.length - 1) {
                // If there's only one character remaining after a nondigit, it must be a special character
                if (!"!@#$%^&*_".includes(nodeId[pos])) return false;
            }
        }

        // Special character at the very end
        if (pos === nodeId.length - 1 && "!@#$%^&*_".includes(nodeId[pos])) {
            pos++;
        }
    }

    return true;
}

export function getParentId(nodeId: string): string | null {
    if (!isValidNodeId(nodeId)) return null;

    // Root nodes have no parent
    if (nodeId.length <= 2) {
        return null;
    }
    // First level nodes (parent is first 2 digits)
    else if (nodeId.length === 3) {
        return nodeId.substring(0, 2);
    }
    // Second level and beyond
    else {
        // If last character is non-numeric, remove just that character
        if (!/\d/.test(nodeId[nodeId.length - 1])) {
            return nodeId.substring(0, nodeId.length - 1);
        }
        // Otherwise remove last two digits
        return nodeId.substring(0, nodeId.length - 2);
    }
}

function findExistingNode(name: string, id: string | undefined, graph: FileGraph): GraphNode | undefined {
    return Array.from(graph.nodes.values()).find(node => 
        node.name === name && node.id === id && !node.isDirectory
    );
}

function addParentEdgesToGraph(
    node: GraphNode, 
    graph: FileGraph, 
    originalParentPath?: string // Optional: physical parent folder path
): void {
    let addedEdge = false;

    if (node.id) {
        const parentId = getParentId(node.id);
        if (parentId) {
            // First check if the physical parent folder has this ID
            const parentFolder = originalParentPath ? graph.nodes.get(originalParentPath) : null;
            let parentNode = parentFolder?.id === parentId ? parentFolder : 
                Array.from(graph.nodes.values()).find(n => n.id === parentId);

            if (!parentNode) {
                // Create surrogate node only if we couldn't find a matching folder
                const surrogatePath = `__surrogate_${parentId}`;
                parentNode = {
                    path: surrogatePath,
                    name: `[${parentId}]`,
                    id: parentId,
                    isDirectory: false,
                    isSurrogate: true,
                    extensions: new Set(),
                    paths: new Set([surrogatePath])
                };
                graph.nodes.set(surrogatePath, parentNode);
                
                // Recursively process the surrogate node
                addParentEdgesToGraph(parentNode, graph);
            }

            // Add edge from parent to this node
            if (!graph.edges.has(parentNode.path)) {
                graph.edges.set(parentNode.path, new Set());
            }
            graph.edges.get(parentNode.path)!.add(node.path);
            addedEdge = true;
        }
    }

    // Only add folder edge if:
    // 1. We haven't added an edge yet (no Folgezettel parent found)
    // 2. The folder isn't already the Folgezettel parent (would be redundant)
    if (!addedEdge && originalParentPath && originalParentPath !== '/') {
        if (!graph.edges.has(originalParentPath)) {
            graph.edges.set(originalParentPath, new Set());
        }
        graph.edges.get(originalParentPath)!.add(node.path);
    } else if (!addedEdge) {
        // If no edges added at all, this should be a child of root
        graph.edges.get('/')!.add(node.path);
    }
}

function shouldIgnorePath(path: string, patterns: string[]): boolean {
    if (path === '/') return false; // Never ignore root
    
    for (const pattern of patterns) {
        const trimmedPattern = pattern.trim();
        if (!trimmedPattern) continue;

        // For __pycache__ and similar directory patterns, match if they appear anywhere in the path
        if (trimmedPattern === '__pycache__' && path.includes('__pycache__')) {
            console.log(`Ignoring path ${path} - contains __pycache__`);
            return true;
        }

        // For other patterns, use minimatch
        const fullPattern = trimmedPattern.startsWith('**/') ? trimmedPattern : `**/${trimmedPattern}`;
        if (minimatch(path, fullPattern, { dot: true })) {
            console.log(`Ignoring path ${path} - matched pattern ${fullPattern}`);
            return true;
        }
    }
    return false;
}

export function buildFileGraph(items: Array<TFile | TFolder>, app: App): FileGraph {
    // Get plugin instance and settings
    const plugin = (app as any).plugins.getPlugin('mms');
    const ignorePatterns = plugin?.settings?.ignorePatterns || [];
    console.log('Building graph with ignore patterns:', ignorePatterns);

    const graph: FileGraph = {
        nodes: new Map(),
        edges: new Map()
    };

    // Add root directory
    const rootNode: GraphNode = {
        path: '/',
        name: '/',
        isDirectory: true,
        isSurrogate: false,
        extensions: new Set(),
        paths: new Set(['/'])
    };
    graph.nodes.set('/', rootNode);
    graph.edges.set('/', new Set());

    // Sort items by path (ensures parents processed before children)
    const sortedItems = [...items].sort((a, b) => a.path.localeCompare(b.path));
    
    let ignoredCount = 0;
    // Process each item
    for (const item of sortedItems) {
        // Check if this item should be ignored
        if (shouldIgnorePath(item.path, ignorePatterns)) {
            ignoredCount++;
            continue;
        }

        const isDirectory = item instanceof TFolder;
        
        // Parse name and ID, using basename for files
        const basename = isDirectory ? item.name : (item as TFile).basename;
        const parts = basename.split(/\s+/);
        const firstWord = parts[0];
        const id = parts.length > 1 && isValidNodeId(firstWord) ? firstWord : undefined;
        const name = id ? parts.slice(1).join(' ') : basename;

        // Determine node type based on ID suffix
        let nodeType: 'mapping' | 'planning' | undefined;
        if (id) {
            if (id.endsWith('#')) nodeType = 'mapping';
            else if (id.endsWith('&')) nodeType = 'planning';
        }

        if (isDirectory) {
            const node: GraphNode = {
                path: item.path,
                name,
                id,
                nodeType,
                isDirectory: true,
                isSurrogate: false,
                extensions: new Set(),
                paths: new Set([item.path])
            };
            graph.nodes.set(item.path, node);
        } else {
            const file = item as TFile;
            const existingNode = findExistingNode(name, id, graph);

            if (existingNode) {
                // Add extension and path to existing node
                existingNode.extensions.add(file.extension);
                existingNode.paths.add(file.path);
                // Map the new path to the existing node
                graph.nodes.set(file.path, existingNode);
            } else {
                // Create new node
                const node: GraphNode = {
                    path: file.path,
                    name,
                    id,
                    nodeType,
                    isDirectory: false,
                    isSurrogate: false,
                    extensions: new Set([file.extension]),
                    paths: new Set([file.path])
                };
                graph.nodes.set(file.path, node);
            }
        }

        // Process parent edges for the node (existing or new)
        const node = graph.nodes.get(item.path)!;
        addParentEdgesToGraph(
            node,
            graph,
            item.parent ? item.parent.path : '/'
        );
    }

    console.log(`Filtered ${ignoredCount} items based on ignore patterns`);

    return graph;
}
