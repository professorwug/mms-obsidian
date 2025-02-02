import { App, Modal, TFile } from 'obsidian';

export class RenameModal extends Modal {
    private file: TFile;
    private onSubmit: (newName: string) => void;
    private inputEl: HTMLInputElement;

    constructor(app: App, file: TFile, onSubmit: (newName: string) => void) {
        super(app);
        this.file = file;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const {contentEl} = this;

        contentEl.createEl('h2', {text: 'Rename File and Extension Variants'});

        // Get base name without extension
        const baseName = this.file.basename;
        
        // Create input field
        this.inputEl = contentEl.createEl('input', {
            type: 'text',
            value: baseName
        });
        this.inputEl.style.width = '100%';
        this.inputEl.style.marginBottom = '1em';

        // Create button container
        const buttonContainer = contentEl.createDiv();
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'flex-end';
        buttonContainer.style.gap = '10px';
        
        buttonContainer.createEl('button', {text: 'Cancel'}).onclick = () => {
            this.close();
        };

        // Add Submit button
        const submitButton = buttonContainer.createEl('button', {
            text: 'Rename',
            cls: 'mod-cta'
        });
        submitButton.onclick = () => {
            const newName = this.inputEl.value.trim();
            if (newName) {
                this.onSubmit(newName);
                this.close();
            }
        };

        // Focus input and select all text
        this.inputEl.focus();
        this.inputEl.select();

        // Handle Enter key
        this.inputEl.onkeydown = (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                const newName = this.inputEl.value.trim();
                if (newName) {
                    this.onSubmit(newName);
                    this.close();
                }
            }
        };
    }

    onClose() {
        const {contentEl} = this;
        contentEl.empty();
    }
}
