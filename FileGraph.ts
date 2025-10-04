import { TFile, TFolder } from 'obsidian';
import { minimatch } from 'minimatch';

export interface GraphNode {
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

export interface SerializedGraphNode {
    path: string;
    name: string;
    id?: string;
    nodeType?: 'mapping' | 'planning';
    extensions: string[];
    isDirectory: boolean;
    isSurrogate: boolean;
    paths: string[];
}

export interface SerializedFileGraph {
    nodes: Record<string, SerializedGraphNode>;
    edges: Record<string, string[]>;
}

export interface EdgeChange {
    parent: string;
    child: string;
}

export interface GraphDiff {
    addedNodes: string[];
    removedNodes: string[];
    changedNodes: string[];
    addedEdges: EdgeChange[];
    removedEdges: EdgeChange[];
    hasChanges: boolean;
}

export type VaultChange =
    | { type: 'create'; file: TFile | TFolder }
    | { type: 'delete'; path: string; isDirectory: boolean }
    | { type: 'rename'; file: TFile | TFolder; oldPath: string; wasDirectory: boolean };

/**
 * Validates if a string represents a valid Folgezettel ID with alternating number/letter pattern
 * Valid formats:
 * - Level 1: exactly 2 digits (e.g., "01", "42")
 * - Level 2: parent ID + one letter (e.g., "01a", "42b")
 * - Level 3: parent ID + two digits (e.g., "01a01", "42b03")
 * - Level 4: parent ID + one letter (e.g., "01a01a", "42b03z")
 * - Level 5: parent ID + two digits (e.g., "01a01a01", "42b03z42")
 * - Special nodes: any valid ID + special character at the end (e.g., "01a#", "01a01&")
 * 
 * @param nodeId The ID to validate
 * @returns true if the ID is valid, false otherwise
 */
export function isValidNodeId(nodeId: string): boolean {
    // Check for minimum length
    if (nodeId.length < 2) return false;
    
    // Handle special characters at the end (mapping, planning, etc.)
    let idToCheck = nodeId;
    const specialChars = "&!@$%^#_-";  // * removed as it's not allowed on Windows
    if (specialChars.includes(nodeId[nodeId.length - 1])) {
        // Remove the special character for validation
        idToCheck = nodeId.slice(0, -1);
        
        // If removing the special character makes it too short, it's invalid
        if (idToCheck.length < 2) return false;
    }
    
    // First level: exactly 2 digits
    if (idToCheck.length === 2) {
        return /^\d{2}$/.test(idToCheck);
    }
    
    // First two characters must be digits
    if (!/^\d{2}$/.test(idToCheck.substring(0, 2))) return false;
    
    // Process the ID starting after the first two digits
    let pos = 2;
    let expectLetter = true; // Track whether we expect a letter or digits
    
    while (pos < idToCheck.length) {
        if (expectLetter) {
            // We expect a letter at this position
            if (!/^[a-zA-Z]$/.test(idToCheck[pos])) {
                return false;
            }
            pos++;
            expectLetter = false; // Next we expect digits
        } else {
            // We expect two digits at this position
            // If there's less than 2 characters left, check that they're all digits
            if (pos + 1 >= idToCheck.length) {
                // Check the remaining 1 character is a digit
                return /^\d+$/.test(idToCheck.substring(pos));
            }
            
            // Check that the next two characters are digits
            if (!/^\d{2}$/.test(idToCheck.substring(pos, pos + 2))) {
                return false;
            }
            pos += 2;
            expectLetter = true; // Next we expect a letter
        }
    }
    
    // If we've processed the entire ID, it's valid
    return true;
}

/**
 * Determines the parent ID for a given Folgezettel ID based on alternating pattern
 * Examples:
 * - "01" -> null (root IDs have no parent)
 * - "01a" -> "01" (level 2 nodes point to their root level parent)
 * - "01a01" -> "01a" (level 3 nodes point to their level 2 parent)
 * - "01a01b" -> "01a01" (level 4 nodes point to their level 3 parent)
 * - "01a01b01" -> "01a01b" (level 5 nodes point to their level 4 parent)
 * - "01a#" -> "01a" (special nodes without the special character)
 * 
 * @param nodeId The ID to find the parent for
 * @returns The parent ID, or null if the ID is invalid or has no parent
 */
export function getParentId(nodeId: string): string | null {
    if (!isValidNodeId(nodeId)) return null;

    // Check for special character at the end (mapping, planning, etc.)
    const specialChars = "&!@$%^#_-";  // * removed as it's not allowed on Windows
    if (specialChars.includes(nodeId[nodeId.length - 1])) {
        // For special nodes, the parent is the ID without the special character
        return nodeId.substring(0, nodeId.length - 1);
    }
    
    // Root nodes have no parent
    if (nodeId.length <= 2) {
        return null;
    }
    
    // For the alternating pattern, we need to look at the length to determine the parent
    const idLen = nodeId.length;
    
    // Calculate the parent ID based on the pattern:
    // If ending with a letter (even positions after pos 2): remove the last letter
    // If ending with 2 digits (3 or more characters after pos 2): remove the last 2 digits
    
    // Check if the ID ends with a letter
    if (/[a-zA-Z]$/.test(nodeId)) {
        // Remove the last letter
        return nodeId.substring(0, idLen - 1);
    }
    
    // Check if the ID ends with 2 digits (should be the case for all valid IDs at this point)
    if (idLen >= 4 && /\d{2}$/.test(nodeId.substring(idLen - 2))) {
        // Remove the last 2 digits
        return nodeId.substring(0, idLen - 2);
    }
    
    // For IDs with a single digit at the end (shouldn't happen with valid IDs, but handle anyway)
    if (/\d$/.test(nodeId)) {
        // Try to find the position where the number section starts
        let pos = idLen - 1;
        while (pos > 2 && /\d$/.test(nodeId[pos])) {
            pos--;
        }
        // Return everything up to the position where digits start
        return nodeId.substring(0, pos + 1);
    }
    
    // If we can't determine the parent pattern (shouldn't happen with valid IDs)
    // Default to returning the root level (first 2 digits)
    return nodeId.substring(0, 2);
}

function findExistingNode(name: string, id: string | undefined, graph: FileGraph): GraphNode | undefined {
    return Array.from(graph.nodes.values()).find(node => 
        node.name === name && node.id === id && !node.isDirectory
    );
}

/**
 * Adds parent-child edges to the graph based on Folgezettel IDs and/or folder structure
 * 
 * @param node The node to add edges for
 * @param graph The file graph
 * @param originalParentPath The physical parent folder path (optional)
 * @param processedIds Set of IDs already processed (to prevent recursion loops)
 */
function addParentEdgesToGraph(
    node: GraphNode, 
    graph: FileGraph, 
    originalParentPath?: string, // Optional: physical parent folder path
    processedIds: Set<string> = new Set() // Track processed IDs to prevent recursion loops
): void {
    let addedEdge = false;

    // Skip if we've already processed this ID (prevent infinite recursion)
    if (node.id && processedIds.has(node.id)) {
        return;
    }
    
    // Mark this ID as processed if it exists
    if (node.id) {
        processedIds.add(node.id);
    }

    if (node.id) {
        const parentId = getParentId(node.id);
        if (parentId) {
            // First check if the physical parent folder has this ID
            const parentFolder = originalParentPath ? graph.nodes.get(originalParentPath) : null;
            
            // Find parent node - first check if physical parent folder matches, then search all nodes
            let parentNode = parentFolder?.id === parentId ? parentFolder : 
                Array.from(graph.nodes.values()).find(n => n.id === parentId);

            if (!parentNode) {
                // Make sure the parent ID is valid before creating a surrogate
                if (isValidNodeId(parentId)) {
                    // Create surrogate node only if we couldn't find a matching folder
                    const surrogatePath = `__surrogate_${parentId}`;
                    parentNode = {
                        path: surrogatePath,
                        name: parentId ? `[${parentId}]` : '[Unnamed Parent]', // Ensure name is never empty
                        id: parentId,
                        isDirectory: false,
                        isSurrogate: true,
                        extensions: new Set(),
                        paths: new Set([surrogatePath])
                    };
                    graph.nodes.set(surrogatePath, parentNode);
                    
                    // Recursively process the surrogate node with the tracking set
                    addParentEdgesToGraph(parentNode, graph, undefined, processedIds);
                }
            }

            // Only add the edge if we have a valid parent node
            if (parentNode) {
                // Add edge from parent to this node
                if (!graph.edges.has(parentNode.path)) {
                    graph.edges.set(parentNode.path, new Set());
                }
                graph.edges.get(parentNode.path)!.add(node.path);
                addedEdge = true;
            }
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
            return true;
        }

        // For other patterns, use minimatch
        const fullPattern = trimmedPattern.startsWith('**/') ? trimmedPattern : `**/${trimmedPattern}`;
        if (minimatch(path, fullPattern, { dot: true })) {
            return true;
        }
    }
    return false;
}

function createEmptyGraph(): FileGraph {
    const rootNode: GraphNode = {
        path: '/',
        name: '/',
        isDirectory: true,
        isSurrogate: false,
        extensions: new Set(),
        paths: new Set(['/'])
    };

    return {
        nodes: new Map([[rootNode.path, rootNode]]),
        edges: new Map([[rootNode.path, new Set()]])
    };
}

function cloneFileGraph(graph: FileGraph): FileGraph {
    const nodeClones = new Map<GraphNode, GraphNode>();
    const nodes = new Map<string, GraphNode>();

    graph.nodes.forEach((node, path) => {
        let clone = nodeClones.get(node);
        if (!clone) {
            clone = {
                path: node.path,
                name: node.name,
                id: node.id,
                nodeType: node.nodeType,
                isDirectory: node.isDirectory,
                isSurrogate: node.isSurrogate,
                extensions: new Set(node.extensions),
                paths: new Set(node.paths),
            };
            nodeClones.set(node, clone);
        }
        nodes.set(path, clone);
    });

    const edges = new Map<string, Set<string>>();
    graph.edges.forEach((children, parent) => {
        edges.set(parent, new Set(children));
    });

    return { nodes, edges };
}

function collectItemsForRebuild(item: TFile | TFolder): Array<TFile | TFolder> {
    const items: Array<TFile | TFolder> = [];
    const stack: Array<TFile | TFolder> = [item];

    while (stack.length > 0) {
        const current = stack.pop()!;
        items.push(current);

        if (current instanceof TFolder) {
            for (const child of current.children) {
                if (child instanceof TFile || child instanceof TFolder) {
                    stack.push(child);
                }
            }
        }
    }

    return items;
}

function removeSinglePath(graph: FileGraph, path: string) {
    if (path === '/') {
        return; // Never remove root
    }

    const node = graph.nodes.get(path);
    const childSet = graph.edges.get(path);

    if (childSet) {
        graph.edges.delete(path);
    }

    graph.edges.forEach(children => {
        children.delete(path);
    });

    if (!node) {
        return;
    }

    graph.nodes.delete(path);
    node.paths.delete(path);

    if (node.path !== path) {
        return;
    }

    if (node.paths.size === 0) {
        return;
    }

    const newPrimary = node.paths.values().next().value;
    node.path = newPrimary;

    if (!graph.nodes.has(newPrimary)) {
        graph.nodes.set(newPrimary, node);
    }

    if (childSet) {
        const existing = graph.edges.get(newPrimary);
        if (!existing) {
            graph.edges.set(newPrimary, new Set(childSet));
        } else {
            childSet.forEach(child => existing.add(child));
        }
    }

    graph.edges.forEach(children => {
        if (children.has(path)) {
            children.delete(path);
            children.add(newPrimary);
        }
    });
}

function removePathsFromGraph(
    graph: FileGraph,
    removals: Array<{ path: string; includeDescendants: boolean }>
) {
    const targets = new Set<string>();

    for (const removal of removals) {
        targets.add(removal.path);
        if (removal.includeDescendants) {
            const prefix = removal.path.endsWith('/') ? removal.path : `${removal.path}/`;
            graph.nodes.forEach((_node, existingPath) => {
                if (existingPath !== removal.path && existingPath.startsWith(prefix)) {
                    targets.add(existingPath);
                }
            });
        }
    }

    const ordered = Array.from(targets).sort((a, b) => b.length - a.length);
    for (const path of ordered) {
        removeSinglePath(graph, path);
    }
}

function cleanupOrphanedSurrogates(graph: FileGraph) {
    const toRemove: string[] = [];

    graph.nodes.forEach((node, path) => {
        if (!node.isSurrogate) {
            return;
        }

        const hasChildren = graph.edges.get(node.path)?.size ?? 0;
        if (hasChildren > 0) {
            return;
        }

        const hasParent = Array.from(graph.edges.values()).some(children => children.has(node.path));
        if (!hasParent) {
            toRemove.push(path);
        }
    });

    toRemove.forEach(path => {
        graph.nodes.delete(path);
        graph.edges.delete(path);
        graph.edges.forEach(children => children.delete(path));
    });
}

function upsertItemIntoGraph(
    graph: FileGraph,
    item: TFile | TFolder,
    ignorePatterns: string[],
): boolean {
    if (shouldIgnorePath(item.path, ignorePatterns)) {
        return false;
    }

    const isDirectory = item instanceof TFolder;

    // Parse name and ID, using basename for files
    const basename = isDirectory ? item.name : (item as TFile).basename;
    const parts = basename.split(/\s+/).filter(p => p.trim() !== ''); // Filter out empty parts
    const firstWord = parts.length > 0 ? parts[0] : '';
    const id = parts.length > 1 && isValidNodeId(firstWord) ? firstWord : undefined;
    // Ensure name is never empty
    const name = id && parts.length > 1 ?
        parts.slice(1).join(' ') || `[Unnamed-${Date.now().toString().slice(-4)}]` :
        basename || `[Unnamed-${Date.now().toString().slice(-4)}]`;

    // Determine node type based on ID suffix
    let nodeType: 'mapping' | 'planning' | undefined;
    if (id) {
        if (id.endsWith('%')) nodeType = 'mapping';
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
            existingNode.extensions.add(file.extension);
            existingNode.paths.add(file.path);
            graph.nodes.set(file.path, existingNode);
        } else {
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

    const node = graph.nodes.get(item.path)!;
    addParentEdgesToGraph(
        node,
        graph,
        item.parent ? item.parent.path : '/'
    );

    return true;
}

export function buildFileGraph(items: Array<TFile | TFolder>, ignorePatterns: string[]): FileGraph {
    console.log('Building graph with ignore patterns:', ignorePatterns);

    const graph = createEmptyGraph();

    const sortedItems = [...items].sort((a, b) => a.path.localeCompare(b.path));

    let ignoredCount = 0;
    for (const item of sortedItems) {
        const processed = upsertItemIntoGraph(graph, item, ignorePatterns);
        if (!processed) {
            ignoredCount++;
        }
    }

    console.log(`Filtered ${ignoredCount} items based on ignore patterns`);

    return graph;
}

export function applyVaultChangesToGraph(
    previous: FileGraph,
    changes: VaultChange[],
    ignorePatterns: string[],
): FileGraph {
    if (changes.length === 0) {
        return previous;
    }

    const graph = cloneFileGraph(previous);
    const removals: Array<{ path: string; includeDescendants: boolean }> = [];
    const itemsToProcess = new Map<string, TFile | TFolder>();

    for (const change of changes) {
        if (change.type === 'delete') {
            removals.push({ path: change.path, includeDescendants: change.isDirectory });
            continue;
        }

        if (change.type === 'rename') {
            removals.push({ path: change.oldPath, includeDescendants: change.wasDirectory });
        }

        const sourceItem = change.file;
        const collected = collectItemsForRebuild(sourceItem);
        for (const item of collected) {
            itemsToProcess.set(item.path, item);
        }
    }

    if (removals.length > 0) {
        removePathsFromGraph(graph, removals);
    }

    const sortedItems = Array.from(itemsToProcess.values()).sort((a, b) => a.path.localeCompare(b.path));
    for (const item of sortedItems) {
        upsertItemIntoGraph(graph, item, ignorePatterns);
    }

    cleanupOrphanedSurrogates(graph);

    return graph;
}

function setsAreEqual<T>(a: Set<T>, b: Set<T>): boolean {
    if (a.size !== b.size) {
        return false;
    }

    for (const value of a) {
        if (!b.has(value)) {
            return false;
        }
    }

    return true;
}

function nodesAreEqual(a: GraphNode, b: GraphNode): boolean {
    return (
        a.path === b.path &&
        a.name === b.name &&
        a.id === b.id &&
        a.nodeType === b.nodeType &&
        a.isDirectory === b.isDirectory &&
        a.isSurrogate === b.isSurrogate &&
        setsAreEqual(a.extensions, b.extensions) &&
        setsAreEqual(a.paths, b.paths)
    );
}

export function diffFileGraphs(previous: FileGraph | null, next: FileGraph): GraphDiff {
    const addedNodes: string[] = [];
    const removedNodes: string[] = [];
    const changedNodes: string[] = [];
    const addedEdges: EdgeChange[] = [];
    const removedEdges: EdgeChange[] = [];

    if (!previous) {
        addedNodes.push(...Array.from(next.nodes.keys()));
        next.edges.forEach((children, parent) => {
            children.forEach(child => {
                addedEdges.push({ parent, child });
            });
        });

        return {
            addedNodes,
            removedNodes,
            changedNodes,
            addedEdges,
            removedEdges,
            hasChanges: addedNodes.length > 0 || addedEdges.length > 0,
        };
    }

    // Compare nodes
    previous.nodes.forEach((_node, path) => {
        if (!next.nodes.has(path)) {
            removedNodes.push(path);
        }
    });

    next.nodes.forEach((node, path) => {
        const previousNode = previous.nodes.get(path);
        if (!previousNode) {
            addedNodes.push(path);
            return;
        }

        if (!nodesAreEqual(previousNode, node)) {
            changedNodes.push(path);
        }
    });

    const allParents = new Set<string>([
        ...Array.from(previous.edges.keys()),
        ...Array.from(next.edges.keys()),
    ]);

    allParents.forEach(parent => {
        const previousChildren = previous.edges.get(parent) || new Set<string>();
        const nextChildren = next.edges.get(parent) || new Set<string>();

        previousChildren.forEach(child => {
            if (!nextChildren.has(child)) {
                removedEdges.push({ parent, child });
            }
        });

        nextChildren.forEach(child => {
            if (!previousChildren.has(child)) {
                addedEdges.push({ parent, child });
            }
        });
    });

    return {
        addedNodes,
        removedNodes,
        changedNodes,
        addedEdges,
        removedEdges,
        hasChanges:
            addedNodes.length > 0 ||
            removedNodes.length > 0 ||
            changedNodes.length > 0 ||
            addedEdges.length > 0 ||
            removedEdges.length > 0,
    };
}

export function serializeFileGraph(graph: FileGraph): SerializedFileGraph {
    const serializedNodes: Record<string, SerializedGraphNode> = {};
    graph.nodes.forEach((node, path) => {
        serializedNodes[path] = {
            path: node.path,
            name: node.name,
            id: node.id,
            nodeType: node.nodeType,
            extensions: Array.from(node.extensions),
            isDirectory: node.isDirectory,
            isSurrogate: node.isSurrogate,
            paths: Array.from(node.paths),
        };
    });

    const serializedEdges: Record<string, string[]> = {};
    graph.edges.forEach((children, parent) => {
        serializedEdges[parent] = Array.from(children);
    });

    return {
        nodes: serializedNodes,
        edges: serializedEdges,
    };
}

export function deserializeFileGraph(serialized: SerializedFileGraph): FileGraph {
    const nodes = new Map<string, GraphNode>();
    Object.entries(serialized.nodes).forEach(([path, node]) => {
        nodes.set(path, {
            path: node.path,
            name: node.name,
            id: node.id,
            nodeType: node.nodeType,
            extensions: new Set(node.extensions),
            isDirectory: node.isDirectory,
            isSurrogate: node.isSurrogate,
            paths: new Set(node.paths),
        });
    });

    const edges = new Map<string, Set<string>>();
    Object.entries(serialized.edges).forEach(([parent, children]) => {
        edges.set(parent, new Set(children));
    });

    return {
        nodes,
        edges,
    };
}
