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

// Per-item search data, computed ONCE when the modal opens. Recomputing text
// segments, char counts, and word boundaries for every item on every keystroke
// made each keystroke cost 500ms+ in large vaults.
interface PreparedItem {
    item: TAbstractFile;
    fileName: string;              // lowercase basename segment used for matching
    parentFolder: string;          // lowercase parent folder segment
    fileNameBoundaries: Set<number>;
    parentFolderBoundaries: Set<number>;
}

// Word boundaries: position 0 plus transitions from non-alphanumeric to alphanumeric
function computeWordBoundaries(text: string): Set<number> {
    const boundaries = new Set<number>([0]);
    for (let i = 1; i < text.length; i++) {
        if (!/[a-zA-Z0-9]/.test(text[i - 1]) && /[a-zA-Z0-9]/.test(text[i])) {
            boundaries.add(i);
        }
    }
    return boundaries;
}

// Allocation-free subsequence test: do all query chars appear in text, in order?
function isSubsequence(query: string, text: string): boolean {
    let qi = 0;
    for (let ti = 0; ti < text.length && qi < query.length; ti++) {
        if (text[ti] === query[qi]) qi++;
    }
    return qi === query.length;
}

// IMPORTANT: We're now extending SuggestModal directly instead of FuzzySuggestModal
// This gives us more control over item rendering
export class FolgemoveModal extends SuggestModal<ScoredItem> {
    private resolvePromise: ((value: TAbstractFile | null) => void) | null = null;
    private allItems: TAbstractFile[];
    private graph: FileGraph;
    private preparedItems: PreparedItem[];
    private emptyQueryResults: ScoredItem[];

    constructor(app: App, placeholder = "Type to search for destination file or folder...") {
        super(app);
        this.setPlaceholder(placeholder);

        // Render at most this many suggestions — the DOM was the other half of
        // the slowness when a query (or no query) matched thousands of items
        this.limit = 100;

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

        // Precompute per-item search segments and word boundaries
        this.preparedItems = this.allItems.map(item => {
            const text = this.getItemText({ item, score: 0 }).replace(/\(.*?\) /, '');
            const segments = text.split('/');
            const fileName = (segments.pop() || '').toLowerCase();
            const parentFolder = (segments.pop() || '').toLowerCase();
            return {
                item,
                fileName,
                parentFolder,
                fileNameBoundaries: computeWordBoundaries(fileName),
                parentFolderBoundaries: computeWordBoundaries(parentFolder)
            };
        });

        // The empty-query listing is static per modal — compute it once
        this.emptyQueryResults = this.allItems
            .map(item => ({ item, score: 1.0 }))
            .sort((a, b) => this.customSort(a.item, b.item));
    }
    
    // Score one precomputed text part against the query. Returns 0 when the
    // query is not a subsequence of the part.
    private scorePart(lowerQuery: string, text: string, wordBoundaries: Set<number>): number {
        const CONSECUTIVE_MATCH_BONUS = 1.5;  // Bonus for consecutive character matches
        const PREFIX_BONUS = 2.0;             // Bonus for matching at start of string
        const UNMATCHED_PENALTY = 0.1;        // Penalty for characters between matches
        const WORD_BOUNDARY_BONUS = 1.75;     // Bonus for matching at word boundaries

        let queryIndex = 0;
        let partialScore = 0;
        let lastMatch = -2; // sentinel: no previous match

        for (let i = 0; i < text.length && queryIndex < lowerQuery.length; i++) {
            if (text[i] === lowerQuery[queryIndex]) {
                let matchScore = 1.0;
                if (wordBoundaries.has(i)) {
                    matchScore *= WORD_BOUNDARY_BONUS;
                }
                if (i === 0) {
                    matchScore *= PREFIX_BONUS;
                }
                if (lastMatch === i - 1) {
                    matchScore *= CONSECUTIVE_MATCH_BONUS;
                } else if (lastMatch >= 0) {
                    matchScore *= Math.pow(UNMATCHED_PENALTY, i - lastMatch - 1);
                }
                partialScore += matchScore;
                lastMatch = i;
                queryIndex++;
            }
        }

        return queryIndex === lowerQuery.length ? partialScore : 0;
    }

    // Override getSuggestions to implement our fuzzy search
    getSuggestions(query: string): ScoredItem[] {
        if (!query) {
            return this.emptyQueryResults;
        }

        const PREFIX_BONUS = 2.0;
        const FILE_NAME_PRIORITY = 2.0;       // Multiplier for matches in filename vs. folder

        const lowerQuery = query.toLowerCase();
        const scoredItems: ScoredItem[] = [];

        for (const prepared of this.preparedItems) {
            let bestScore = 0;

            // Filename first; the allocation-free subsequence test filters out
            // the vast majority of items before any scoring work happens
            if (prepared.fileName && isSubsequence(lowerQuery, prepared.fileName)) {
                bestScore = this.scorePart(lowerQuery, prepared.fileName, prepared.fileNameBoundaries) * FILE_NAME_PRIORITY;
            } else if (prepared.parentFolder && isSubsequence(lowerQuery, prepared.parentFolder)) {
                bestScore = this.scorePart(lowerQuery, prepared.parentFolder, prepared.parentFolderBoundaries);
            }

            if (bestScore > 0) {
                // Normalize score based on query length for fair comparison
                const normalizedScore = bestScore / (lowerQuery.length * PREFIX_BONUS * FILE_NAME_PRIORITY);
                scoredItems.push({
                    item: prepared.item,
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

    onClose(): void {
        super.onClose();
        // Resolve with null when the modal closes without a selection (e.g. Esc).
        // Note: modalEl never fires a 'closed' DOM event, so this must happen here.
        // Deferred by a tick because SuggestModal calls close() BEFORE
        // onChooseSuggestion() — resolving synchronously here would turn every
        // actual selection into a "cancel" (the selection would arrive after the
        // promise was already settled with null).
        setTimeout(() => {
            if (this.resolvePromise) {
                this.resolvePromise(null);
                this.resolvePromise = null;
            }
        }, 0);
    }

    async getResult(): Promise<TAbstractFile | null> {
        return new Promise((resolve) => {
            this.resolvePromise = resolve;
        });
    }
}