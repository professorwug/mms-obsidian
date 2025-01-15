import { FileGraph } from './FileGraph';

export function getNextAvailableChildId(parentPath: string, graph: FileGraph): string {
    // Get the parent node
    const parentNode = graph.nodes.get(parentPath);
    if (!parentNode) {
        throw new Error(`Parent node ${parentPath} not found in graph`);
    }

    const parentId = parentNode.id;
    if (!parentId) {
        return '';
    }

    // Get all children of the parent using graph edges
    const childIds = new Set<string>();
    const children = graph.edges.get(parentPath) || new Set<string>();
    
    for (const childPath of children) {
        const childNode = graph.nodes.get(childPath);
        if (childNode?.id && childNode.id.startsWith(parentId)) {
            childIds.add(childNode.id);
        }
    }

    // Determine if we should add a number or letter based on parent_id
    if (/\d$/.test(parentId)) {
        // Parent ends in number, add letters
        const usedLetters = new Set(
            Array.from(childIds)
                .map(id => id[parentId.length])
                .filter(char => char)
        );

        // Find first unused letter (a-z)
        for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
            if (!usedLetters.has(letter)) {
                return `${parentId}${letter}`;
            }
        }

        throw new Error(`No available letter suffixes for parent ${parentId}`);
    } else {
        // Parent ends in letter (or is root), add two-digit numbers
        const usedNumbers = new Set(
            Array.from(childIds)
                .map(id => id.slice(parentId.length, parentId.length + 2))
                .filter(num => num.length === 2)
        );

        // Find first unused two-digit number
        for (let i = 1; i < 100; i++) {
            const candidate = i.toString().padStart(2, '0');
            if (!usedNumbers.has(candidate)) {
                return `${parentId}${candidate}`;
            }
        }

        throw new Error(`No available number suffixes for parent ${parentId}`);
    }
}
