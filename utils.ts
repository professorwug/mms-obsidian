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
