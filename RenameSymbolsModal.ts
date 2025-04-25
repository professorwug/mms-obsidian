import { App, Modal, Setting, Notice, TFile } from 'obsidian';

interface RenameSymbolsResult {
    targetSymbol: string;
    replacementSymbol: string;
}

export class RenameSymbolsModal extends Modal {
    private result: RenameSymbolsResult;
    private resolvePromise: (value: RenameSymbolsResult | null) => void;
    private problematicFiles: TFile[] = [];
    private processedCount: number = 0;
    private totalCount: number = 0;
    private statusEl: HTMLElement;

    constructor(app: App, problematicFiles: TFile[]) {
        super(app);
        this.problematicFiles = problematicFiles;
        this.totalCount = problematicFiles.length;
        this.result = {
            targetSymbol: '*',
            replacementSymbol: ''
        };
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Fix Special Characters in Filenames' });

        const descEl = contentEl.createEl('p', { 
            text: `Found ${this.totalCount} files with special characters that may cause problems on some operating systems.` 
        });

        if (this.totalCount > 0) {
            const examplesEl = contentEl.createEl('div', { cls: 'rename-symbols-examples' });
            examplesEl.createEl('h3', { text: 'Examples:' });
            const examplesList = examplesEl.createEl('ul');
            
            // Show up to 5 examples
            const exampleCount = Math.min(5, this.problematicFiles.length);
            for (let i = 0; i < exampleCount; i++) {
                examplesList.createEl('li', { text: this.problematicFiles[i].path });
            }
            
            if (this.problematicFiles.length > 5) {
                examplesList.createEl('li', { text: `...and ${this.problematicFiles.length - 5} more` });
            }
        }

        new Setting(contentEl)
            .setName('Target Symbol')
            .setDesc('Choose which special character to replace (leave empty to replace all)')
            .addText(text => {
                text.setValue(this.result.targetSymbol)
                    .onChange(value => {
                        this.result.targetSymbol = value;
                    });
                return text;
            });

        new Setting(contentEl)
            .setName('Replacement')
            .setDesc('What to replace the special character with (leave empty to remove)')
            .addText(text => {
                text.setValue(this.result.replacementSymbol)
                    .onChange(value => {
                        this.result.replacementSymbol = value;
                    });
                return text;
            });

        this.statusEl = contentEl.createEl('div', { cls: 'rename-symbols-status' });
        this.updateStatus();

        const buttonSetting = new Setting(contentEl);
        
        if (this.totalCount > 0) {
            buttonSetting.addButton(btn =>
                btn
                    .setButtonText('Fix Files')
                    .setCta()
                    .onClick(() => {
                        this.resolvePromise(this.result);
                        this.close();
                    }));
        }
        
        buttonSetting.addButton(btn =>
            btn
                .setButtonText('Cancel')
                .onClick(() => {
                    this.resolvePromise(null);
                    this.close();
                }));
    }

    private updateStatus() {
        this.statusEl.empty();
        if (this.processedCount > 0) {
            this.statusEl.createEl('p', { 
                text: `Processed ${this.processedCount} of ${this.totalCount} files.` 
            });
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
        if (this.resolvePromise) {
            this.resolvePromise(null);
        }
    }

    async openAndGetValue(): Promise<RenameSymbolsResult | null> {
        this.open();
        return new Promise(resolve => {
            this.resolvePromise = resolve;
        });
    }
}
