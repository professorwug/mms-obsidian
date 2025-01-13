import { TFile, TFolder } from 'obsidian';

interface GraphNode {
    path: string;          // Primary path (first file found)
    name: string;          // Display name (without ID if present)
    id?: string;          // Folgezettel ID if present
    extensions: Set<string>; // All file extensions for this node
    isDirectory: boolean;  // Is this a folder?
    isSurrogate: boolean; // Is this a surrogate node for a missing parent?
    paths: Set<string>;   // All paths associated with this node
}

interface FileGraph {
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
    // Check for Folgezettel ID
    let addedEdge = false;

    if (node.id) {
        const parentId = getParentId(node.id);
        if (parentId) {
            // Find or create parent node
            let parentNode = Array.from(graph.nodes.values())
                .find(n => n.id === parentId);

            if (!parentNode) {
                // Create surrogate node
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

    // If no Folgezettel edge added and we have a parent folder path, add folder edge
    if (!addedEdge && originalParentPath && originalParentPath !== '/') {
        if (!graph.edges.has(originalParentPath)) {
            graph.edges.set(originalParentPath, new Set());
        }
        graph.edges.get(originalParentPath)!.add(node.path);
    } else if (!addedEdge) {
        // If no edges added, this should be a child of root
        graph.edges.get('/')!.add(node.path);
    }
}

export function buildFileGraph(items: Array<TFile | TFolder>): FileGraph {
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
    
    // Process each item
    for (const item of sortedItems) {
        const isDirectory = item instanceof TFolder;
        
        // Parse name and ID, using basename for files
        const basename = isDirectory ? item.name : (item as TFile).basename;
        const parts = basename.split(/\s+/);
        const firstWord = parts[0];
        const id = parts.length > 1 && isValidNodeId(firstWord) ? firstWord : undefined;
        const name = id ? parts.slice(1).join(' ') : basename;

        if (isDirectory) {
            const node: GraphNode = {
                path: item.path,
                name,
                id,
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

    return graph;
}
