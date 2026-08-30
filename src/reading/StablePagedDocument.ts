import { App, Component, MarkdownRenderer, MarkdownView } from 'obsidian';

/**
 * A complete, plugin-owned Markdown rendering for paged Reading view.
 *
 * Obsidian's native preview sizer is virtualized: its blocks are replaced as
 * the viewport moves. This renderer deliberately lives beside that sizer,
 * inside the same scroll container, so page breaks have a stable DOM lifetime.
 */
export class StablePagedDocument extends Component {
    readonly root: HTMLElement;

    constructor(
        private readonly app: App,
        private readonly view: MarkdownView,
        private readonly preview: HTMLElement
    ) {
        super();
        this.root = preview.ownerDocument.createElement('div');
        this.root.className = 'markdown-preview-sizer markdown-preview-section mms-paged-document';
        this.root.dataset.mmsStableDocument = 'true';
    }

    onload(): void {
        this.preview.classList.add('mms-stable-reading-active');
        this.preview.prepend(this.root);
    }

    async render(): Promise<void> {
        const file = this.view.file;
        if (!file) return;
        await MarkdownRenderer.render(
            this.app,
            this.view.getViewData(),
            this.root,
            file.path,
            this
        );
        this.root.classList.add('is-rendered');
    }

    onunload(): void {
        this.root.remove();
        this.preview.classList.remove('mms-stable-reading-active');
    }
}
