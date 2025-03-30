import { App, SuggestModal, TFile, TFolder, TAbstractFile, FuzzyMatch } from 'obsidian';
import { FileGraph, GraphNode } from './FileGraph';

// Helper function to get the length of the common prefix between two strings
// Make sure to compare case-insensitively
function getCommonPrefixLength(a: string, b: string): number {
    // Convert both strings to lowercase to ensure case-insensitive comparison
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    
    const minLength = Math.min(aLower.length, bLower.length);
    for (let i = 0; i < minLength; i++) {
        if (aLower[i] !== bLower[i]) return i;
    }
    return minLength;
}

// Interface for search results with scores
interface ScoredItem {
    item: TAbstractFile;
    score: number;
}

// IMPORTANT: We're now extending SuggestModal directly instead of FuzzySuggestModal
// This gives us more control over item rendering
export class FolgemoveModal extends SuggestModal<ScoredItem> {
    private resolvePromise: ((value: TAbstractFile | null) => void) | null = null;
    private allItems: TAbstractFile[];
    private graph: FileGraph;

    constructor(app: App) {
        super(app);
        this.setPlaceholder("Type to search for destination file or folder...");
        
        // Get both files and folders
        const files = this.app.vault.getFiles();
        const folders = this.app.vault.getAllLoadedFiles()
            .filter(f => f instanceof TFolder) as TFolder[];
        
        // Get the file graph from the plugin
        const plugin = (this.app as any).plugins.getPlugin('mms');
        this.graph = plugin?.getActiveGraph() || { nodes: new Map(), edges: new Map() };
        
        // Sort folders and files with our custom sort function
        const sortedFolders = folders.sort(this.customSort.bind(this));
        const sortedFiles = files.sort(this.customSort.bind(this));

        // Combine with folders first
        this.allItems = [...sortedFolders, ...sortedFiles];
    }
    
    // Override getSuggestions to implement our fuzzy search
    getSuggestions(query: string): ScoredItem[] {
        if (!query) {
            // Return all items with a default score of 1.0
            return this.allItems.map(item => ({ 
                item,
                score: 1.0
            })).sort((a, b) => this.customSort(a.item, b.item));
        }
        
        const lowerQuery = query.toLowerCase();
        const scoredItems: ScoredItem[] = [];
        
        // Constants for scoring
        const CONSECUTIVE_MATCH_BONUS = 1.5;  // Bonus for consecutive character matches
        const PREFIX_BONUS = 2.0;             // Bonus for matching at start of word
        const UNMATCHED_PENALTY = 0.1;        // Penalty for characters between matches
        const WORD_BOUNDARY_BONUS = 1.75;     // Bonus for matching at word boundaries
        const FILE_NAME_PRIORITY = 2.0;       // Multiplier for matches in filename vs. folder
        
        // Score each item
        for (const item of this.allItems) {
            let text = this.getItemText({ item, score: 0 }); // Pass dummy score
            text = text.replace(/\(.*?\) /, ''); // Remove any existing score for matching
            
            // Extract just filename and parent folder for focused matching
            const segments = text.split('/');
            const fileName = segments.pop() || '';
            const parentFolder = segments.pop() || '';
            
            // Try to match in filename first, then parent folder
            const nameParts = [fileName, parentFolder];
            let bestScore = 0;
            
            for (let partIndex = 0; partIndex < nameParts.length; partIndex++) {
                const text = nameParts[partIndex].toLowerCase();
                if (!text) continue;
                
                // Check if text contains all query characters
                let canMatch = true;
                const charCounts: {[key: string]: number} = {};
                for (const char of text) {
                    charCounts[char] = (charCounts[char] || 0) + 1;
                }
                for (const char of lowerQuery) {
                    if (!charCounts[char]) {
                        canMatch = false;
                        break;
                    }
                    charCounts[char]--;
                }
                if (!canMatch) continue;
                
                // Track positions of query character matches in text
                const positions: number[] = [];
                let queryIndex = 0;
                let partialScore = 0;
                
                // Word boundaries in the text
                const wordBoundaries = new Set<number>();
                wordBoundaries.add(0); // Start of text is a boundary
                for (let i = 1; i < text.length; i++) {
                    // Word boundary at transitions from non-alphanumeric to alphanumeric
                    if (
                        !/[a-zA-Z0-9]/.test(text[i-1]) && 
                        /[a-zA-Z0-9]/.test(text[i])
                    ) {
                        wordBoundaries.add(i);
                    }
                }
                
                // Fuzzy search algorithm with scoring
                for (let i = 0; i < text.length && queryIndex < lowerQuery.length; i++) {
                    if (text[i] === lowerQuery[queryIndex]) {
                        // Calculate match score based on position and context
                        let matchScore = 1.0;
                        
                        // Bonus for matching at word boundaries
                        if (wordBoundaries.has(i)) {
                            matchScore *= WORD_BOUNDARY_BONUS;
                        }
                        
                        // Bonus for matching at start of string
                        if (i === 0) {
                            matchScore *= PREFIX_BONUS;
                        }
                        
                        // Bonus for consecutive matches
                        if (positions.length > 0 && positions[positions.length - 1] === i - 1) {
                            matchScore *= CONSECUTIVE_MATCH_BONUS;
                        } else if (positions.length > 0) {
                            // Penalty for gaps between matches
                            matchScore *= Math.pow(UNMATCHED_PENALTY, i - positions[positions.length - 1] - 1);
                        }
                        
                        partialScore += matchScore;
                        positions.push(i);
                        queryIndex++;
                    }
                }
                
                // Only count if all query characters were found
                if (queryIndex === lowerQuery.length) {
                    // Weight score based on whether it's in filename or folder
                    const itemScore = partialScore * (partIndex === 0 ? FILE_NAME_PRIORITY : 1.0);
                    bestScore = Math.max(bestScore, itemScore);
                }
                
                // If we found a full match in filename, no need to check parent folder
                if (queryIndex === lowerQuery.length && partIndex === 0) {
                    break;
                }
            }
            
            // If we found a match, add it to results
            if (bestScore > 0) {
                // Normalize score based on query length for fair comparison
                const normalizedScore = bestScore / (lowerQuery.length * PREFIX_BONUS * FILE_NAME_PRIORITY);
                scoredItems.push({
                    item,
                    score: normalizedScore
                });
            }
        }
        
        // Sort scored items by score (descending)
        scoredItems.sort((a, b) => b.score - a.score);
        
        // Group by similarity tiers
        const tiers: ScoredItem[][] = [];
        let currentTier: ScoredItem[] = [];
        let previousScore: number | null = null;
        
        // Get max score for relative comparison
        const maxScore = scoredItems[0]?.score || 1;
        
        // Split items into tiers based on score breaks
        const SCORE_BREAK_THRESHOLD = 0.15; // 15% difference in scores indicates a new tier
        
        for (let i = 0; i < scoredItems.length; i++) {
            const scoredItem = scoredItems[i];
            const normalizedScore = scoredItem.score / maxScore; // Normalize score relative to max
            
            // For the first item
            if (previousScore === null) {
                currentTier.push(scoredItem);
                previousScore = normalizedScore;
                continue;
            }
            
            // Check if this item's score is significantly different from the previous one
            const scoreDiff = Math.abs(previousScore - normalizedScore);
            
            // If score is significantly lower, create a new tier
            if (scoreDiff > SCORE_BREAK_THRESHOLD) {
                if (currentTier.length > 0) {
                    tiers.push(currentTier);
                    currentTier = [scoredItem];
                }
            } else {
                currentTier.push(scoredItem);
            }
            
            previousScore = normalizedScore;
        }
        
        // Add the last tier
        if (currentTier.length > 0) {
            tiers.push(currentTier);
        }
        
        // Sort each tier by custom sort and flatten
        const result: ScoredItem[] = [];
        for (const tier of tiers) {
            tier.sort((a, b) => this.customSort(a.item, b.item));
            result.push(...tier);
        }
        
        return result;
    }
    
    // Override renderSuggestion to show scores
    renderSuggestion(scoredItem: ScoredItem, el: HTMLElement): void {
        const { item, score } = scoredItem;
        
        // Create the container with flexbox for layout
        el.style.display = 'flex';
        el.style.justifyContent = 'space-between';
        el.style.alignItems = 'center';
        
        // Create the item text element (left side)
        const textEl = document.createElement('span');
        textEl.style.overflow = 'hidden';
        textEl.style.textOverflow = 'ellipsis';
        textEl.style.whiteSpace = 'nowrap';
        
        // Format the text with icon and ID if applicable
        const node = this.graph.nodes.get(item.path);
        const nodeId = node?.id ? `[${node.id}] ` : '';
        const icon = item instanceof TFolder ? '📁 ' : '';
        textEl.textContent = `${icon}${nodeId}${item.path}`;
        
        // Create the score element (right side)
        const scoreEl = document.createElement('span');
        scoreEl.style.marginLeft = '10px';
        scoreEl.style.opacity = '0.7';
        scoreEl.style.fontSize = '0.9em';
        scoreEl.textContent = `[${score.toFixed(2)}]`;
        
        // Add both elements to the suggestion
        el.appendChild(textEl);
        el.appendChild(scoreEl);
    }
    
    // Override getItemText to provide text for search matching
    getItemText(scoredItem: ScoredItem): string {
        const item = scoredItem.item;
        
        // Get the node from the graph
        const node = this.graph.nodes.get(item.path);
        const nodeId = node?.id ? `[${node.id}] ` : '';
        
        // Text with folder icon and node ID
        const text = item instanceof TFolder ? 
            `📁 ${nodeId}${item.path}` : 
            `${nodeId}${item.path}`;
            
        return text;
    }

    // This method is called by SuggestModal base class
    onChooseSuggestion(scoredItem: ScoredItem, evt: MouseEvent | KeyboardEvent): void {
        if (this.resolvePromise) {
            this.resolvePromise(scoredItem.item);
            this.resolvePromise = null;
        }
    }
    
    // Custom sort function that prioritizes nodes with IDs and sorts by ID length
    private customSort(a: TAbstractFile, b: TAbstractFile): number {
        const nodeA = this.graph.nodes.get(a.path);
        const nodeB = this.graph.nodes.get(b.path);
        
        // First, prioritize items with IDs over ones without
        const aHasId = nodeA && nodeA.id;
        const bHasId = nodeB && nodeB.id;
        
        if (aHasId && !bHasId) return -1;
        if (!aHasId && bHasId) return 1;
        
        // If both have IDs, sort by ID length
        if (aHasId && bHasId && nodeA && nodeB) {
            const idLenDiff = nodeA.id!.length - nodeB.id!.length;
            if (idLenDiff !== 0) return idLenDiff;
        }
        
        // Fall back to path length sorting
        const lenDiff = a.path.length - b.path.length;
        // Use case-insensitive comparison for paths
        return lenDiff !== 0 ? lenDiff : a.path.toLowerCase().localeCompare(b.path.toLowerCase());
    }

    async getResult(): Promise<TAbstractFile | null> {
        return new Promise((resolve) => {
            this.resolvePromise = resolve;
            
            // Set up a one-time close handler that resolves with null if no item was selected
            const closeHandler = () => {
                if (this.resolvePromise) {
                    this.resolvePromise(null);
                    this.resolvePromise = null;
                }
                this.modalEl.removeEventListener('closed', closeHandler);
            };
            this.modalEl.addEventListener('closed', closeHandler);
        });
    }
}