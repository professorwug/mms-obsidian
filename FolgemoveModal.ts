import { App, FuzzySuggestModal, TFile } from 'obsidian';

export class FolgemoveModal extends FuzzySuggestModal<TFile> {
    private resolvePromise: ((value: TFile | null) => void) | null = null;
    private items: TFile[];

    constructor(app: App) {
        super(app);
        this.setPlaceholder("Type to search for destination file...");
        this.items = this.app.vault.getFiles();
    }

    getItems(): TFile[] {
        return this.items;
    }

    getItemText(file: TFile): string {
        return file.path;
    }

    onChooseItem(file: TFile, evt: MouseEvent | KeyboardEvent): void {
        console.log("File chosen:", file.path);
        if (this.resolvePromise) {
            console.log("Resolving with file");
            this.resolvePromise(file);
            this.resolvePromise = null;
        }
    }

    async getResult(): Promise<TFile | null> {
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
