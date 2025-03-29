import { App, Modal, Setting } from 'obsidian';
import { isMobileApp } from './utils';

export type NoteType = 'searching' | 'mapping' | 'planning' | 'marimo';

interface FollowUpResult {
    name: string;
    type: NoteType;
}

export class FollowUpModal extends Modal {
    private result: FollowUpResult;
    private resolvePromise: (value: FollowUpResult | null) => void;

    constructor(app: App) {
        super(app);
        this.result = {
            name: '',
            type: 'searching'
        };
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Create Follow Up Note' });

        new Setting(contentEl)
            .setName('Note Name')
            .setDesc('Enter the name for the follow up note')
            .addText(text => {
                text.setValue(this.result.name)
                    .onChange(value => {
                        this.result.name = value;
                    });
                
                // Handle Enter key
                text.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        this.resolvePromise(this.result);
                        this.close();
                    }
                });
                
                text.inputEl.focus();
                return text;
            });

        new Setting(contentEl)
            .setName('Note Type')
            .setDesc('Choose the type of note to create')
            .addDropdown(dropdown => {
                dropdown
                    .addOption('searching', 'Searching')
                    .addOption('mapping', 'Mapping')
                    .addOption('planning', 'Planning');
                
                // Only add Marimo option on desktop
                if (!isMobileApp()) {
                    dropdown.addOption('marimo', 'Marimo (py)');
                }
                
                dropdown.setValue(this.result.type)
                    .onChange(value => {
                        this.result.type = value as NoteType;
                    });
            });

        new Setting(contentEl)
            .addButton(btn =>
                btn
                    .setButtonText('Create')
                    .setCta()
                    .onClick(() => {
                        this.resolvePromise(this.result);
                        this.close();
                    }))
            .addButton(btn =>
                btn
                    .setButtonText('Cancel')
                    .onClick(() => {
                        this.resolvePromise(null);
                        this.close();
                    }));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
        if (this.resolvePromise) {
            this.resolvePromise(null);
        }
    }

    async openAndGetValue(): Promise<FollowUpResult | null> {
        this.open();
        return new Promise(resolve => {
            this.resolvePromise = resolve;
        });
    }
}
