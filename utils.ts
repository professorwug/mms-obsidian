import { FileGraph } from './FileGraph';
import { Platform, App } from 'obsidian';

/**
 * Checks if the plugin is running on a mobile device
 * @returns true if running on mobile, false otherwise
 */
export function isMobileApp(): boolean {
    return Platform.isMobile;
}

/**
 * Checks if a feature is available on the current platform
 * @param feature The feature to check
 * @returns true if the feature is available, false otherwise
 */
export function isFeatureAvailable(feature: 'filesystem' | 'shell' | 'marimo' | 'externalEditor'): boolean {
    if (isMobileApp()) {
        // These features don't work on mobile
        if (feature === 'filesystem' || feature === 'shell' || 
            feature === 'marimo' || feature === 'externalEditor') {
            return false;
        }
    }
    return true;
}

/**
 * Gets a platform-appropriate file path
 * @param path The original path
 * @param app The Obsidian app instance
 * @returns A platform-appropriate path
 */
export function getPlatformAppropriateFilePath(path: string, app: App): string {
    if (isMobileApp()) {
        // On mobile, we can't use absolute paths with the file system
        return path;
    } else {
        // On desktop, we can use the vault adapter to get the full path
        try {
            const basePath = (app.vault.adapter as any).basePath;
            const fullPath = require('path').resolve(basePath, path);
            return fullPath;
        } catch (e) {
            console.error('Error getting absolute path:', e);
            return path;
        }
    }
}

/**
 * Executes a command based on platform capability
 * @param command The command to execute
 * @param app The Obsidian app instance
 * @param filePath Optional file path related to the command
 * @param mobileAlternative Function to run as alternative on mobile
 * @returns Promise that resolves when the command finishes
 */
export async function executeCommand(
    command: string,
    app: App,
    filePath?: string,
    mobileAlternative?: () => Promise<void>
): Promise<void> {
    if (isMobileApp()) {
        // On mobile, use the alternative if provided
        if (mobileAlternative) {
            await mobileAlternative();
        } else {
            // Default mobile behavior: try to open the file in Obsidian
            if (filePath) {
                const file = app.vault.getAbstractFileByPath(filePath);
                if (file && file.path.endsWith('.md') && 'extension' in file) {
                    await app.workspace.getLeaf('tab').openFile(file as any);
                }
            }
        }
    } else {
        // On desktop, execute the command
        try {
            // This is safe only on desktop
            const { exec } = require('child_process');
            return new Promise((resolve, reject) => {
                exec(command, (error: any) => {
                    if (error) {
                        console.error('Command execution error:', error);
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });
        } catch (e) {
            console.error('Error executing command:', e);
            throw e;
        }
    }
}

/**
 * Generates the next available child ID for a parent node following the alternating Folgezettel pattern
 * - If parent ends with digits (e.g. "01" or "01a01"), add a letter (e.g. "01a" or "01a01b")
 * - If parent ends with a letter (e.g. "01a" or "01a01b"), add two digits (e.g. "01a01" or "01a01b01")
 * 
 * @param parentPath The path of the parent node
 * @param graph The file graph
 * @returns The next available child ID
 */
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
    
    // Remove any special characters at the end for the purpose of child ID generation
    const specialChars = "&!@$%^#_-";  // * removed as it's not allowed on Windows
    let baseParentId = parentId;
    if (specialChars.includes(parentId[parentId.length - 1])) {
        baseParentId = parentId.slice(0, -1);
    }

    // Get all children of the parent using graph edges
    const childIds = new Set<string>();
    const children = graph.edges.get(parentPath) || new Set<string>();
    
    // Get all children regardless of ID validation status
    for (const childPath of children) {
        const childNode = graph.nodes.get(childPath);
        if (childNode?.id && childNode.id.startsWith(baseParentId)) {
            // For the comparison, also remove any special characters
            let childId = childNode.id;
            if (specialChars.includes(childId[childId.length - 1])) {
                childId = childId.slice(0, -1);
            }
            childIds.add(childId);
        }
    }

    // Determine what to add based on the pattern:
    // If parent ends with a digit, add a letter
    // If parent ends with a letter, add two digits
    const endsWithDigit = /\d$/.test(baseParentId);
    
    if (endsWithDigit) {
        // Parent ends with a digit, so add a letter
        const usedLetters = new Set<string>();
        
        // Extract used letters by comparing with parent ID prefix
        for (const childId of childIds) {
            if (childId.length > baseParentId.length) {
                // Extract the letter that follows the parent ID
                const letter = childId[baseParentId.length];
                if (letter && /^[a-zA-Z]$/.test(letter)) {
                    usedLetters.add(letter.toLowerCase());
                }
            }
        }

        // Find first unused letter (a-z)
        // Include 'f' since we've fixed the validation issues
        const letters = 'abcdefghijklmnopqrstuvwxyz';
        for (const letter of letters) {
            if (!usedLetters.has(letter)) {
                return `${baseParentId}${letter}`;
            }
        }

        throw new Error(`No available letter suffixes for parent ${baseParentId}`);
    } else {
        // Parent ends with a letter, so add two digits
        const usedNumbers = new Set<string>();
        
        // Extract used numbers
        for (const childId of childIds) {
            if (childId.length >= baseParentId.length + 2) {
                // Extract the 2 digits that follow the parent ID
                const digits = childId.slice(baseParentId.length, baseParentId.length + 2);
                if (digits && /^\d{2}$/.test(digits)) {
                    usedNumbers.add(digits);
                }
            }
        }

        // Find first unused two-digit number
        for (let i = 1; i < 100; i++) {
            const candidate = i.toString().padStart(2, '0');
            if (!usedNumbers.has(candidate)) {
                return `${baseParentId}${candidate}`;
            }
        }

        throw new Error(`No available number suffixes for parent ${baseParentId}`);
    }
}
