import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf } from 'obsidian';
import { FileBrowserView } from './FileBrowserView';
import { FolgemoveModal } from './FolgemoveModal';
import { getNextAvailableChildId } from './utils';

// Remember to rename these classes and interfaces!

interface MMSPluginSettings {
    fileTypeCommands: {
        py: string;
        ipynb: string;
        qmd: string;
        nb: string;
        pdf: string;
    };
}

const DEFAULT_SETTINGS: MMSPluginSettings = {
    fileTypeCommands: {
        py: 'code "$FILEPATH"',
        ipynb: 'code "$FILEPATH"',
        qmd: 'code "$FILEPATH"',
        nb: 'open "$FILEPATH"',
        pdf: '',
    }
}

export default class MMSPlugin extends Plugin {
    settings: MMSPluginSettings;
    private views: FileBrowserView[] = [];

    async onload() {
        await this.loadSettings();

        // Register the custom view type
        this.registerView(
            'folgezettel-browser',
            (leaf: WorkspaceLeaf) => {
                const view = new FileBrowserView(leaf, this);
                this.views.push(view);
                return view;
            }
        );

        // Register file system event handlers
        this.registerEvent(
            this.app.vault.on('create', () => this.refreshViews())
        );
        this.registerEvent(
            this.app.vault.on('delete', () => this.refreshViews())
        );
        this.registerEvent(
            this.app.vault.on('rename', () => this.refreshViews())
        );
        this.registerEvent(
            this.app.vault.on('modify', () => this.refreshViews())
        );

        // Add a ribbon icon for the Folgezettel Browser
        const folgezettelRibbonIconEl = this.addRibbonIcon('folder', 'Folgezettel Browser', async (evt: MouseEvent) => {
            await this.activateView();
        });
        folgezettelRibbonIconEl.addClass('folgezettel-browser-ribbon-class');

        // Automatically open the file browser view
        this.app.workspace.onLayoutReady(() => {
            this.activateView();
        });

        // This creates an icon in the left ribbon.
        const ribbonIconEl = this.addRibbonIcon('dice', 'Sample Plugin', (evt: MouseEvent) => {
            // Called when the user clicks the icon.
            new Notice('This is a notice!');
        });
        // Perform additional things with the ribbon
        ribbonIconEl.addClass('my-plugin-ribbon-class');

        // This adds a status bar item to the bottom of the app. Does not work on mobile apps.
        const statusBarItemEl = this.addStatusBarItem();
        statusBarItemEl.setText('Status Bar Text');

        // This adds a simple command that can be triggered anywhere
        this.addCommand({
            id: 'open-sample-modal-simple',
            name: 'Open sample modal (simple)',
            callback: () => {
                new SampleModal(this.app).open();
            }
        });
        // This adds an editor command that can perform some operation on the current editor instance
        this.addCommand({
            id: 'sample-editor-command',
            name: 'Sample editor command',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                console.log(editor.getSelection());
                editor.replaceSelection('Sample Editor Command');
            }
        });
        // This adds a complex command that can check whether the current state of the app allows execution of the command
        this.addCommand({
            id: 'open-sample-modal-complex',
            name: 'Open sample modal (complex)',
            checkCallback: (checking: boolean) => {
                // Conditions to check
                const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (markdownView) {
                    // If checking is true, we're simply "checking" if the command can be run.
                    // If checking is false, then we want to actually perform the operation.
                    if (!checking) {
                        new SampleModal(this.app).open();
                    }

                    // This command will only show up in Command Palette when the check function returns true
                    return true;
                }
            }
        });

        this.addCommand({
            id: 'folgemove',
            name: 'Folgemove - Move and rename file based on destination',
            checkCallback: (checking: boolean) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (!activeFile) return false;
                
                if (!checking) {
                    this.folgemove(activeFile);
                }
                
                return true;
            }
        });

        // This adds a settings tab so the user can configure various aspects of the plugin
        this.addSettingTab(new MMSSettingTab(this.app, this));

        // If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
        // Using this function will automatically remove the event listener when this plugin is disabled.
        this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
            console.log('click', evt);
        });

        // When registering intervals, this function will automatically clear the interval when the plugin is disabled.
        this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
    }

    onunload() {
        this.views = [];
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        console.log('Loaded settings:', this.settings);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async activateView() {
        const { workspace } = this.app;

        let leaf = workspace.getLeavesOfType('folgezettel-browser')[0];
        if (!leaf) {
            leaf = workspace.getLeftLeaf(false);
            await leaf.setViewState({ type: 'folgezettel-browser' });
        }

        workspace.revealLeaf(leaf);
    }

    // Method to refresh all file browser views while preserving state
    private refreshViews() {
        this.views.forEach(view => {
            if (view) {
                view.refreshPreservingState();
            }
        });
    }

    private async folgemove(sourceFile: TFile) {
        try {
            // Open modal to select destination
            const modal = new FolgemoveModal(this.app);
            modal.open();
            const targetFile = await modal.getResult();
            
            if (!targetFile) {
                return; // User cancelled
            }

            // Get target directory
            const targetDir = targetFile.parent;
            if (!targetDir) {
                new Notice("Invalid target location");
                return;
            }

            // Get current FileBrowserView instance to access the graph
            const fileBrowserView = this.views.find(view => view instanceof FileBrowserView) as FileBrowserView;
            if (!fileBrowserView?.currentGraph) {
                new Notice("File browser not initialized");
                return;
            }

            // First move the file to target directory
            const newPath = `${targetDir.path}/${sourceFile.name}`;
            await this.app.fileManager.renameFile(sourceFile, newPath);

            // If target has a folgezettel ID, get new ID for source
            const targetNode = fileBrowserView.currentGraph.nodes.get(targetFile.path);
            if (targetNode?.id) {
                const newId = getNextAvailableChildId(targetFile.path, fileBrowserView.currentGraph);
                if (newId) {
                    // Rename file with new ID
                    const baseName = sourceFile.name.replace(/^\d+[a-z]\d*\s+/, ''); // Remove any existing ID
                    const newName = `${newId} ${baseName}`;
                    const finalPath = `${targetDir.path}/${newName}`;
                    
                    await this.app.fileManager.renameFile(
                        this.app.vault.getAbstractFileByPath(newPath) as TFile,
                        finalPath
                    );
                }
            }

            // The views will be automatically refreshed by the file system event handlers
            new Notice("File moved successfully");
        } catch (error) {
            new Notice(`Error moving file: ${error.message}`);
            console.error('Folgemove error:', error);
        }
    }
}

class SampleModal extends Modal {
    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.setText('Woah!');
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class MMSSettingTab extends PluginSettingTab {
    plugin: MMSPlugin;

    constructor(app: App, plugin: MMSPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'File Type Actions' });
        containerEl.createEl('p', { text: 'Configure commands to run when clicking different file types. Leave empty to use default behavior.' });
        containerEl.createEl('p', { text: 'Use $FILEPATH in your command where you want the file path to be inserted. For example: code "$FILEPATH" or open -a "Preview" "$FILEPATH"' });

        const fileTypes = ['py', 'ipynb', 'qmd', 'nb', 'pdf'];

        for (const ext of fileTypes) {
            new Setting(containerEl)
                .setName(`${ext.toUpperCase()} files`)
                .setDesc(`Command to run for .${ext} files`)
                .addText(text => text
                    .setPlaceholder(`Command for .${ext} files`)
                    .setValue(this.plugin.settings.fileTypeCommands[ext])
                    .onChange(async (value) => {
                        this.plugin.settings.fileTypeCommands[ext] = value;
                        await this.plugin.saveSettings();
                    }));
        }
    }
}
