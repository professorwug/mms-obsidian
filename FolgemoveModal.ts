import { App, FuzzySuggestModal, TFile, TFolder, TAbstractFile } from 'obsidian';

export class FolgemoveModal extends FuzzySuggestModal<TAbstractFile> {
    private resolvePromise: ((value: TAbstractFile | null) => void) | null = null;
    private items: TAbstractFile[];

    constructor(app: App) {
        super(app);
        this.setPlaceholder("Type to search for destination file or folder...");
        
        // Get both files and folders
        const files = this.app.vault.getFiles();
        const folders = this.app.vault.getAllLoadedFiles()
            .filter(f => f instanceof TFolder) as TFolder[];
        
        this.items = [...folders, ...files];
    }

    getItems(): TAbstractFile[] {
        return this.items;
    }

    getItemText(item: TAbstractFile): string {
        // Add a prefix to distinguish folders
        return item instanceof TFolder ? `📁 ${item.path}` : item.path;
    }

    onChooseItem(item: TAbstractFile, evt: MouseEvent | KeyboardEvent): void {
        console.log("Item chosen:", item.path);
        if (this.resolvePromise) {
            console.log("Resolving with item");
            this.resolvePromise(item);
            this.resolvePromise = null;
        }
    }

    async getResult(): Promise<TAbstractFile | null> {
        console.log("Getting result...");
        return new Promise((resolve) => {
            console.log("Setting up promise...");
            this.resolvePromise = resolve;
            
            // Set up a one-time close handler that resolves with null if no item was selected
            const closeHandler = () => {
                console.log("Close handler triggered");
                if (this.resolvePromise) {
                    console.log("Resolving with null due to close");
                    this.resolvePromise(null);
                    this.resolvePromise = null;
                }
                this.modalEl.removeEventListener('closed', closeHandler);
            };
            this.modalEl.addEventListener('closed', closeHandler);
        });
    }
}
