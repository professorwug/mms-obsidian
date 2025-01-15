import { App, Modal, TFile } from 'obsidian';

export class FolgemoveModal extends Modal {
    private result: TFile | null = null;
    private resolved: boolean = false;

    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Select destination file or folder" });

        // Create search input
        const inputEl = contentEl.createEl("input", {
            type: "text",
            placeholder: "Type to search files...",
        });
        
        // Create results container
        const resultsEl = contentEl.createEl("div");
        
        // Handle input changes
        inputEl.addEventListener("input", async () => {
            const query = inputEl.value.toLowerCase();
            const files = this.app.vault.getFiles();
            
            // Clear previous results
            resultsEl.empty();
            
            // Filter and display matching files
            files.filter(file => 
                file.path.toLowerCase().contains(query)
            ).forEach(file => {
                const resultEl = resultsEl.createEl("div", {
                    text: file.path,
                    cls: "suggestion-item",
                });
                
                resultEl.addEventListener("click", () => {
                    this.result = file;
                    this.resolved = true;
                    this.close();
                });
            });
        });

        // Focus input
        inputEl.focus();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }

    async getResult(): Promise<TFile | null> {
        return new Promise((resolve) => {
            this.resolved = false;
            this.result = null;
            
            const interval = setInterval(() => {
                if (this.resolved) {
                    clearInterval(interval);
                    resolve(this.result);
                }
            }, 100);
        });
    }
}
