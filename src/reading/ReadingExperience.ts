import { Component, MarkdownView, Notice, Plugin } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { Compartment, StateEffect } from '@codemirror/state';
import { PagedReadingController, ReadingDocumentPosition } from './PagedReadingController';
import { SidenoteController } from './SidenoteController';
import { StablePagedDocument } from './StablePagedDocument';
import { ReadingFeatureSettings } from './types';
import { anchorTextsMatch, findBestAnchorElement } from './position';
import { ReadingSelectionController } from './ReadingSelectionController';

class ReadingPaneController {
    private readonly sidenotes: SidenoteController;
    private readonly pagination: PagedReadingController;
    private readonly selectionActions: ReadingSelectionController;
    private readonly observer: MutationObserver;
    private readonly resizeObserver: ResizeObserver;
    private stableDocument: StablePagedDocument | null = null;
    private stableSource = '';
    private syncTimer: number | null = null;
    private positionTimer: number | null = null;
    private modeFreezeTimer: number | null = null;
    private nativeHighlightTimer: number | null = null;
    private renderGeneration = 0;
    private destroyed = false;
    private initialPosition: ReadingDocumentPosition | null;
    private initiallyPaged: boolean;
    private lastPagedPosition: ReadingDocumentPosition | null = null;
    private modePositionFrozen = false;
    private readonly onModePointerDown = (event: PointerEvent) => {
        const target = (event.target as Element | null)?.closest<HTMLElement>('.view-action');
        const label = target?.getAttribute('aria-label')?.toLocaleLowerCase() ?? '';
        if (label.includes('current view: reading')) this.freezeModePosition();
    };
    private readonly onModeKeyDown = (event: KeyboardEvent) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'e') {
            this.freezeModePosition();
        }
    };

    constructor(
        private readonly plugin: Plugin,
        private view: MarkdownView,
        readonly readingView: HTMLElement,
        readonly preview: HTMLElement,
        private readonly getSettings: () => ReadingFeatureSettings,
        initialPosition: ReadingDocumentPosition | null = null,
        initiallyPaged = false,
        private readonly modeStateChanged: (
            position: ReadingDocumentPosition,
            paged: boolean
        ) => void = () => {}
    ) {
        this.initialPosition = initialPosition;
        this.initiallyPaged = initiallyPaged;
        this.sidenotes = new SidenoteController(preview);
        this.selectionActions = new ReadingSelectionController(plugin.app, view, preview);
        this.pagination = new PagedReadingController(
            readingView,
            preview,
            active => this.setPagedActive(active),
            position => {
                if (this.modePositionFrozen || this.view.getMode() !== 'preview') return;
                this.lastPagedPosition = position;
                this.modeStateChanged(position, true);
            },
            () => {
                const content = this.stableDocument?.root;
                if (content) this.sidenotes.sync(this.getSettings().enableSidenotes, content);
            }
        );
        this.observer = new MutationObserver(mutations => this.handleMutations(mutations));
        this.resizeObserver = new ResizeObserver(() => {
            if (this.pagination.isActive()) this.scheduleSync(120);
            else this.scheduleSync();
        });
        this.observe();
        this.resizeObserver.observe(preview);
        preview.ownerDocument.addEventListener('pointerdown', this.onModePointerDown, true);
        preview.ownerDocument.addEventListener('keydown', this.onModeKeyDown, true);
        this.positionTimer = this.ownerWindow().setInterval(() => {
            if (
                this.modePositionFrozen
                || !this.pagination.isActive()
                || this.view.getMode() !== 'preview'
            ) return;
            const position = this.pagination.capturePosition();
            this.lastPagedPosition = position;
            this.modeStateChanged(position, true);
        }, 500);
        readingView.classList.add('mms-reading-pane');
        this.syncNow();
    }

    updateView(view: MarkdownView): void {
        this.view = view;
        if (this.pagination.isActive()) {
            if (this.stableSource !== this.currentSource()) void this.rebuildStableDocument();
            return;
        }
        this.scheduleSync();
    }

    syncNow(): void {
        if (this.destroyed) return;
        if (this.syncTimer !== null) {
            this.ownerWindow().clearTimeout(this.syncTimer);
            this.syncTimer = null;
        }
        this.observer.disconnect();
        const settings = this.getSettings();
        const activateInitially = settings.pagedReadingByDefault || this.initiallyPaged;
        this.pagination.setAvailable(settings.enablePagedReading, activateInitially);
        this.initiallyPaged = false;
        if (!activateInitially && this.initialPosition) {
            const position = this.initialPosition;
            this.initialPosition = null;
            void this.restoreNativePosition(position);
        }
        if (this.pagination.isActive() && this.stableDocument) {
            this.sidenotes.sync(settings.enableSidenotes, this.stableDocument.root);
            this.pagination.scheduleLayout();
        } else {
            this.sidenotes.sync(settings.enableSidenotes);
        }
        this.observe();
    }

    togglePagination(): boolean {
        return this.pagination.toggle();
    }

    getPerformanceSamples() {
        return this.pagination.getPerformanceSamples();
    }

    matchesView(view: MarkdownView): boolean {
        return this.view === view;
    }

    captureModeState(): { position: ReadingDocumentPosition; paged: boolean } {
        if (this.pagination.isActive()) {
            return {
                position: this.lastPagedPosition ?? this.pagination.capturePosition(),
                paged: true
            };
        }
        return {
            position: this.progressPosition(this.nativeScrollProgress()),
            paged: false
        };
    }

    destroy(): void {
        this.destroyed = true;
        this.renderGeneration += 1;
        if (this.syncTimer !== null) this.ownerWindow().clearTimeout(this.syncTimer);
        if (this.positionTimer !== null) this.ownerWindow().clearInterval(this.positionTimer);
        if (this.modeFreezeTimer !== null) this.ownerWindow().clearTimeout(this.modeFreezeTimer);
        if (this.nativeHighlightTimer !== null) this.ownerWindow().clearTimeout(this.nativeHighlightTimer);
        this.preview.querySelectorAll('.mms-reading-return-target').forEach(element => {
            element.classList.remove('mms-reading-return-target');
        });
        this.preview.ownerDocument.removeEventListener('pointerdown', this.onModePointerDown, true);
        this.preview.ownerDocument.removeEventListener('keydown', this.onModeKeyDown, true);
        this.observer.disconnect();
        this.resizeObserver.disconnect();
        this.pagination.destroy();
        this.selectionActions.destroy();
        this.sidenotes.destroy();
        this.destroyStableDocument();
        this.readingView.classList.remove('mms-reading-pane');
    }

    private async setPagedActive(active: boolean): Promise<void> {
        if (this.destroyed || active === this.pagination.isActive()) return;
        if (active) {
            this.modePositionFrozen = false;
            const position = this.initialPosition
                ?? this.progressPosition(this.nativeScrollProgress());
            this.initialPosition = null;
            await this.mountStableDocument(position);
            return;
        }

        const progress = this.pagination.deactivate();
        this.sidenotes.sync(false, this.stableDocument?.root);
        this.destroyStableDocument();
        this.view.previewMode.rerender(true);
        await this.afterTwoFrames();
        this.restoreNativeProgress(progress.progress);
        this.sidenotes.sync(this.getSettings().enableSidenotes);
    }

    private async rebuildStableDocument(): Promise<void> {
        if (!this.pagination.isActive() || this.destroyed) return;
        const progress = this.pagination.deactivate();
        this.sidenotes.sync(false, this.stableDocument?.root);
        this.destroyStableDocument();
        await this.mountStableDocument(progress);
    }

    private async mountStableDocument(position: ReadingDocumentPosition): Promise<void> {
        const generation = ++this.renderGeneration;
        const document = new StablePagedDocument(this.plugin.app, this.view, this.preview);
        this.stableDocument = document;
        document.load();
        try {
            await document.render();
            if (this.destroyed || generation !== this.renderGeneration || this.stableDocument !== document) {
                document.unload();
                return;
            }
            this.stableSource = this.currentSource();
            this.resizeObserver.observe(document.root);
            this.pagination.activate(document.root, position);
            this.lastPagedPosition = this.pagination.capturePosition();
        } catch (error) {
            if (this.stableDocument === document) this.stableDocument = null;
            document.unload();
            this.view.previewMode.rerender(true);
            console.error('[MMS] Could not create stable paged document', error);
            new Notice('Could not render paged Reading view; restored the native preview');
        }
    }

    private destroyStableDocument(): void {
        const document = this.stableDocument;
        if (!document) return;
        this.renderGeneration += 1;
        this.resizeObserver.unobserve(document.root);
        this.stableDocument = null;
        this.stableSource = '';
        this.lastPagedPosition = null;
        document.unload();
    }

    private handleMutations(mutations: MutationRecord[]): void {
        const stableRoot = this.stableDocument?.root;
        if (stableRoot) {
            const stableMutations = mutations.filter(mutation => (
                stableRoot === mutation.target || stableRoot.contains(mutation.target)
            ));
            if (stableMutations.length && !stableMutations.every(mutation => this.isOwnedMutation(mutation))) {
                this.scheduleSync(120);
            }
            return;
        }
        if (mutations.every(mutation => this.isOwnedMutation(mutation))) return;
        this.scheduleSync();
    }

    private scheduleSync(delay = 400): void {
        if (this.destroyed) return;
        if (this.syncTimer !== null) this.ownerWindow().clearTimeout(this.syncTimer);
        this.syncTimer = this.ownerWindow().setTimeout(() => this.syncNow(), delay);
    }

    private observe(): void {
        this.observer.observe(this.preview, { childList: true, subtree: true });
    }

    private isOwnedMutation(mutation: MutationRecord): boolean {
        const changed = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
        return changed.length > 0 && changed.every(node => {
            if (node.nodeType !== Node.ELEMENT_NODE) return true;
            const element = node as Element;
            return element.matches('[data-mms-owned]') || Boolean(element.closest('[data-mms-owned]'));
        });
    }

    private currentSource(): string {
        return this.view.getViewData();
    }

    private nativeScrollProgress(): number {
        const range = Math.max(0, this.preview.scrollHeight - this.preview.clientHeight);
        return range ? this.preview.scrollTop / range : 0;
    }

    private restoreNativeProgress(progress: number): void {
        const range = Math.max(0, this.preview.scrollHeight - this.preview.clientHeight);
        this.preview.scrollTop = Math.max(0, Math.min(1, progress)) * range;
    }

    private async restoreNativePosition(position: ReadingDocumentPosition): Promise<void> {
        await this.afterTwoFrames();
        if (this.destroyed || this.pagination.isActive()) return;
        this.restoreNativeProgress(position.progress);
        await new Promise<void>(resolve => this.ownerWindow().setTimeout(resolve, 120));
        if (this.destroyed || this.pagination.isActive()) return;
        this.restoreNativeProgress(position.progress);
        this.flashNativePosition(position);
    }

    private flashNativePosition(position: ReadingDocumentPosition): void {
        const anchorText = position.highlightAnchorText ?? position.anchorText;
        if (!anchorText) return;
        const targets = Array.from(this.preview.querySelectorAll<HTMLElement>(
            '.markdown-preview-section h1, .markdown-preview-section h2, '
            + '.markdown-preview-section h3, .markdown-preview-section h4, '
            + '.markdown-preview-section h5, .markdown-preview-section h6, '
            + '.markdown-preview-section p, .markdown-preview-section li, '
            + '.markdown-preview-section blockquote'
        )).filter(element => !element.closest('[data-mms-owned]'));
        const target = findBestAnchorElement(
            anchorText,
            targets,
            position.highlightProgress ?? position.progress
        );
        if (!target) return;
        if (this.nativeHighlightTimer !== null) this.ownerWindow().clearTimeout(this.nativeHighlightTimer);
        target.classList.add('mms-reading-return-target');
        this.nativeHighlightTimer = this.ownerWindow().setTimeout(() => {
            this.nativeHighlightTimer = null;
            target.classList.remove('mms-reading-return-target');
        }, 2200);
    }

    private progressPosition(progress: number): ReadingDocumentPosition {
        return {
            progress: Math.max(0, Math.min(1, progress)),
            headingIndex: -2,
            sectionFraction: 0
        };
    }

    private freezeModePosition(): void {
        if (!this.pagination.isActive() || this.view.getMode() !== 'preview') return;
        const position = this.pagination.capturePosition();
        this.lastPagedPosition = position;
        this.modeStateChanged(position, true);
        this.modePositionFrozen = true;
        if (this.modeFreezeTimer !== null) this.ownerWindow().clearTimeout(this.modeFreezeTimer);
        this.modeFreezeTimer = this.ownerWindow().setTimeout(() => {
            this.modeFreezeTimer = null;
            if (this.view.getMode() === 'preview') this.modePositionFrozen = false;
        }, 1000);
    }

    private async afterTwoFrames(): Promise<void> {
        const ownerWindow = this.ownerWindow();
        await new Promise<void>(resolve => ownerWindow.requestAnimationFrame(() => {
            ownerWindow.requestAnimationFrame(() => resolve());
        }));
    }

    private ownerWindow(): Window {
        return this.preview.ownerDocument.defaultView ?? window;
    }
}

interface SavedReadingModeState {
    position: ReadingDocumentPosition;
    paged: boolean;
}

interface EditorPositionTracker {
    editorView: EditorView;
    updates: Compartment;
    scrollDOM: HTMLElement;
    onScroll: () => void;
    onPointerDown: (event: PointerEvent) => void;
    onKeyDown: (event: KeyboardEvent) => void;
}

/** Coordinates MMS reading enhancements across every open Markdown pane. */
export class ReadingExperience extends Component {
    private readonly panes = new Map<HTMLElement, ReadingPaneController>();
    private readonly modeStates = new Map<string, SavedReadingModeState>();
    private readonly viewModes = new WeakMap<MarkdownView, 'source' | 'preview'>();
    private readonly pendingEditorPositions = new WeakMap<MarkdownView, ReadingDocumentPosition>();
    private readonly editorPositions = new WeakMap<MarkdownView, ReadingDocumentPosition>();
    private readonly frozenEditorViews = new WeakSet<MarkdownView>();
    private readonly editorTrackers = new Map<MarkdownView, EditorPositionTracker>();
    private refreshTimer: number | null = null;
    private readonly onModePointerDown = (event: PointerEvent) => {
        const target = (event.target as Element | null)?.closest<HTMLElement>('.view-action');
        const label = target?.getAttribute('aria-label')?.toLocaleLowerCase() ?? '';
        if (label.includes('current view: editing')) this.freezeEditorPosition();
    };
    private readonly onModeKeyDown = (event: KeyboardEvent) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'e') {
            this.freezeEditorPosition();
        }
    };

    constructor(
        private readonly plugin: Plugin,
        private readonly getSettings: () => ReadingFeatureSettings
    ) {
        super();
    }

    onload(): void {
        this.plugin.registerMarkdownPostProcessor(() => this.scheduleRefresh());
        this.registerEvent(this.plugin.app.workspace.on('layout-change', () => this.scheduleRefresh()));
        this.registerEvent(this.plugin.app.workspace.on('resize', () => this.scheduleRefresh()));
        this.registerEvent(this.plugin.app.workspace.on('active-leaf-change', () => this.scheduleRefresh()));
        this.registerEvent(this.plugin.app.workspace.on('file-open', () => this.scheduleRefresh()));
        this.plugin.app.workspace.onLayoutReady(() => this.scheduleRefresh());
        this.scheduleRefresh();
    }

    onunload(): void {
        if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
        this.editorTrackers.forEach((_, view) => this.stopEditorTracking(view));
        this.panes.forEach(pane => pane.destroy());
        this.panes.clear();
    }

    refresh(): void {
        const liveRoots = new Set<HTMLElement>();
        const liveViews = new Set<MarkdownView>();
        for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
            const view = leaf.view;
            if (!(view instanceof MarkdownView)) continue;
            liveViews.add(view);
            const mode = view.getMode();
            const previousMode = this.viewModes.get(view);
            const path = view.file?.path;
            const paneEntry = Array.from(this.panes.entries())
                .find(([, pane]) => pane.matchesView(view));

            if (mode !== 'preview') {
                if (paneEntry && path) {
                    const [root, pane] = paneEntry;
                    const captured = pane.captureModeState();
                    const cached = this.modeStates.get(path);
                    const state = cached?.paged ? cached : captured;
                    this.modeStates.set(path, state);
                    pane.destroy();
                    this.panes.delete(root);
                    void this.restoreEditorPosition(view, state.position);
                }
                this.viewModes.set(view, 'source');
                this.ensureEditorTracking(view);
                continue;
            }

            const trackedEditorPosition = this.editorPositions.get(view);
            this.stopEditorTracking(view);

            const readingView = view.containerEl.querySelector<HTMLElement>('.markdown-reading-view');
            const preview = readingView?.querySelector<HTMLElement>('.markdown-preview-view');
            if (!readingView || !preview || !this.themeIsActive(preview)) continue;

            liveRoots.add(preview);
            const existing = this.panes.get(preview);
            if (existing) existing.updateView(view);
            else {
                const saved = path ? this.modeStates.get(path) : undefined;
                const frozenEditorPosition = this.pendingEditorPositions.get(view);
                if (frozenEditorPosition) this.pendingEditorPositions.delete(view);
                const editorPosition = previousMode === 'source'
                    ? frozenEditorPosition
                        ?? trackedEditorPosition
                        ?? this.captureEditorPosition(view)
                    : null;
                this.panes.set(
                    preview,
                    new ReadingPaneController(
                        this.plugin,
                        view,
                        readingView,
                        preview,
                        this.getSettings,
                        editorPosition ?? saved?.position ?? null,
                        saved?.paged ?? false,
                        (position, paged) => {
                            if (path) this.modeStates.set(path, { position, paged });
                        }
                    )
                );
            }
            this.viewModes.set(view, 'preview');
        }

        for (const [root, pane] of this.panes) {
            if (!liveRoots.has(root) || !root.isConnected) {
                pane.destroy();
                this.panes.delete(root);
            }
        }
        for (const view of this.editorTrackers.keys()) {
            if (!liveViews.has(view)) this.stopEditorTracking(view);
        }
    }

    refreshSettings(): void {
        this.refresh();
        this.panes.forEach(pane => pane.syncNow());
    }

    toggleActivePanePagination(): void {
        if (!this.getSettings().enablePagedReading) {
            new Notice('Enable paged reading in MMS settings first');
            return;
        }
        const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || view.getMode() !== 'preview') {
            new Notice('Open a note in Reading view to use paged reading');
            return;
        }
        const preview = view.containerEl.querySelector<HTMLElement>('.markdown-reading-view .markdown-preview-view');
        const pane = preview ? this.panes.get(preview) : undefined;
        if (!pane) {
            new Notice('Paged reading requires the MMS theme and must be enabled in MMS settings');
            return;
        }
        const active = pane.togglePagination();
        new Notice(active ? 'Preparing paged Reading view' : 'Paged reading off');
    }

    getPerformanceReport(): string {
        const samples = Array.from(this.panes.values()).flatMap(pane => pane.getPerformanceSamples());
        const summarize = (values: number[]) => {
            if (!values.length) return null;
            const sorted = values.slice().sort((a, b) => a - b);
            const percentile = (fraction: number) => sorted[Math.min(
                sorted.length - 1,
                Math.floor((sorted.length - 1) * fraction)
            )];
            return { median: percentile(0.5), p95: percentile(0.95), maximum: sorted[sorted.length - 1] };
        };
        return JSON.stringify({
            generatedAt: new Date().toISOString(),
            transitions: samples.length,
            summary: {
                inputToAnimationMs: summarize(samples.map(sample => sample.inputToAnimationMs)),
                composeMs: summarize(samples.map(sample => sample.composeMs)),
                longestFrameMs: summarize(samples.map(sample => sample.longestFrameMs)),
                totalMs: summarize(samples.map(sample => sample.totalMs)),
                droppedFrames: samples.reduce((total, sample) => total + sample.droppedFrames, 0),
                transitionsOver50msInputLatency: samples.filter(sample => sample.inputToAnimationMs > 50).length,
                transitionsWithFrameOver25ms: samples.filter(sample => sample.longestFrameMs > 25).length
            },
            samples
        }, null, 2);
    }

    private scheduleRefresh(): void {
        if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
        this.refreshTimer = window.setTimeout(() => {
            this.refreshTimer = null;
            this.refresh();
        }, 60);
    }

    private captureEditorPosition(view: MarkdownView): ReadingDocumentPosition | null {
        const editorView = this.codeMirrorView(view);
        if (!editorView) return null;
        const scrollRect = editorView.scrollDOM.getBoundingClientRect();
        const visibleTop = Math.max(0, scrollRect.top - editorView.documentTop + 1);
        const visibleBottom = Math.max(visibleTop, scrollRect.bottom - editorView.documentTop);
        const firstVisibleBlock = editorView.lineBlockAtHeight(visibleTop);
        let line = editorView.state.doc.lineAt(firstVisibleBlock.from).number - 1;

        // Live Preview renders a generous off-screen buffer, so viewport.from
        // is not the first visible line. Prefer the first non-blank source line
        // actually on screen, which also gives Reading view a semantic anchor.
        let topParagraphLine: number | null = null;
        for (let candidate = line; candidate < editorView.state.doc.lines; candidate += 1) {
            const sourceLine = editorView.state.doc.line(candidate + 1);
            if (editorView.lineBlockAt(sourceLine.from).top > visibleBottom) break;
            if (sourceLine.text.trim()) {
                line = candidate;
                if (this.isParagraphSourceLine(sourceLine.text)) {
                    topParagraphLine = candidate;
                    break;
                }
            }
        }
        const source = view.getViewData();
        const position = this.positionForSourceLine(source, line);
        let highlightLine = topParagraphLine ?? line;
        const cursor = editorView.state.selection.main.head;
        const cursorLine = editorView.state.doc.lineAt(cursor).number - 1;
        const cursorText = editorView.state.doc.line(cursorLine + 1).text;
        if (this.isAnchorableSourceLine(cursorText)) highlightLine = cursorLine;
        const highlight = this.sourceAnchorForLine(source, highlightLine);
        if (highlight) {
            position.highlightAnchorText = highlight.text.slice(0, 480);
            position.highlightProgress = highlight.progress;
        }
        return position;
    }

    private isParagraphSourceLine(line: string): boolean {
        const trimmed = line.trim();
        return Boolean(trimmed)
            && !/^#{1,6}(?:\s+|$)/.test(trimmed)
            && !/^(?:`{3,}|~{3,})/.test(trimmed)
            && !/^(?:---+|___+|\*\*\*+)\s*$/.test(trimmed)
            && !/^\|?(?:\s*:?-+:?\s*\|)+/.test(trimmed);
    }

    private isAnchorableSourceLine(line: string): boolean {
        const trimmed = line.trim();
        return Boolean(trimmed)
            && !/^(?:`{3,}|~{3,})/.test(trimmed)
            && !/^(?:---+|___+|\*\*\*+)\s*$/.test(trimmed)
            && !/^\|?(?:\s*:?-+:?\s*\|)+/.test(trimmed);
    }

    private sourceAnchorForLine(
        source: string,
        line: number
    ): { text: string; progress: number } | null {
        const lines = source.split('\n');
        const lastLine = Math.max(0, lines.length - 1);
        const target = Math.max(0, Math.min(lastLine, line));
        const current = lines[target] ?? '';
        if (!this.isAnchorableSourceLine(current)) return null;
        const trimmed = current.trim();
        const standalone = /^ {0,3}#{1,6}(?:\s+|$)/.test(current)
            || /^\s*(?:[-+*]|\d+[.)])\s+/.test(current)
            || /^\s*>/.test(current)
            || /^\s*\|/.test(current)
            || /^\s*\[\^[^\]]+\]:/.test(current);
        if (standalone) return { text: trimmed, progress: lastLine ? target / lastLine : 0 };

        const isBoundary = (candidate: string): boolean => {
            const value = candidate.trim();
            return !value
                || /^ {0,3}#{1,6}(?:\s+|$)/.test(candidate)
                || /^\s*(?:[-+*]|\d+[.)])\s+/.test(candidate)
                || /^\s*>/.test(candidate)
                || /^(?:`{3,}|~{3,})/.test(value)
                || /^(?:---+|___+|\*\*\*+)\s*$/.test(value)
                || /^\s*\|/.test(candidate)
                || /^\s*\[\^[^\]]+\]:/.test(candidate);
        };
        let start = target;
        let end = target;
        while (start > 0 && !isBoundary(lines[start - 1])) start -= 1;
        while (end < lastLine && !isBoundary(lines[end + 1])) end += 1;
        return {
            text: lines.slice(start, end + 1).map(value => value.trim()).join(' '),
            progress: lastLine ? target / lastLine : 0
        };
    }

    private freezeEditorPosition(): void {
        const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || view.getMode() !== 'source') return;
        const position = this.captureEditorPosition(view);
        if (!position) return;
        this.frozenEditorViews.add(view);
        this.pendingEditorPositions.set(view, position);
        this.editorPositions.set(view, position);
        const path = view.file?.path;
        if (path) {
            const saved = this.modeStates.get(path);
            this.modeStates.set(path, { position, paged: saved?.paged ?? false });
        }
        const ownerWindow = view.containerEl.ownerDocument.defaultView ?? window;
        ownerWindow.setTimeout(() => {
            if (view.getMode() === 'source') this.frozenEditorViews.delete(view);
        }, 1000);
    }

    private ensureEditorTracking(view: MarkdownView): void {
        const editorView = this.codeMirrorView(view);
        if (!editorView) return;
        const existing = this.editorTrackers.get(view);
        if (existing?.scrollDOM === editorView.scrollDOM) {
            this.rememberEditorPosition(view);
            return;
        }
        if (existing) this.stopEditorTracking(view);
        const updates = new Compartment();
        editorView.dispatch({
            effects: StateEffect.appendConfig.of(updates.of(EditorView.updateListener.of(update => {
                if (
                    (update.selectionSet || update.docChanged)
                    && !this.frozenEditorViews.has(view)
                    && view.getMode() === 'source'
                ) {
                    this.rememberEditorPosition(view);
                }
            })))
        });
        const onScroll = () => {
            if (!this.frozenEditorViews.has(view) && view.getMode() === 'source') {
                this.rememberEditorPosition(view);
            }
        };
        const onPointerDown = (event: PointerEvent) => this.onModePointerDown(event);
        const onKeyDown = (event: KeyboardEvent) => this.onModeKeyDown(event);
        editorView.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
        view.containerEl.addEventListener('pointerdown', onPointerDown, true);
        view.containerEl.addEventListener('keydown', onKeyDown, true);
        this.editorTrackers.set(view, {
            editorView,
            updates,
            scrollDOM: editorView.scrollDOM,
            onScroll,
            onPointerDown,
            onKeyDown
        });
        this.rememberEditorPosition(view);
    }

    private stopEditorTracking(view: MarkdownView): void {
        const tracker = this.editorTrackers.get(view);
        if (!tracker) return;
        tracker.scrollDOM.removeEventListener('scroll', tracker.onScroll);
        view.containerEl.removeEventListener('pointerdown', tracker.onPointerDown, true);
        view.containerEl.removeEventListener('keydown', tracker.onKeyDown, true);
        if (tracker.updates.get(tracker.editorView.state) !== undefined) {
            tracker.editorView.dispatch({ effects: tracker.updates.reconfigure([]) });
        }
        this.editorTrackers.delete(view);
    }

    private rememberEditorPosition(view: MarkdownView): void {
        if (this.frozenEditorViews.has(view) || view.getMode() !== 'source') return;
        const position = this.captureEditorPosition(view);
        if (!position) return;
        this.editorPositions.set(view, position);
        const path = view.file?.path;
        if (!path) return;
        const saved = this.modeStates.get(path);
        this.modeStates.set(path, { position, paged: saved?.paged ?? false });
    }

    private async restoreEditorPosition(
        view: MarkdownView,
        position: ReadingDocumentPosition
    ): Promise<void> {
        const ownerWindow = view.containerEl.ownerDocument.defaultView ?? window;
        await new Promise<void>(resolve => ownerWindow.requestAnimationFrame(() => {
            ownerWindow.requestAnimationFrame(() => resolve());
        }));
        if (view.getMode() !== 'source') return;
        const lineNumber = this.sourceLineForPosition(view.getViewData(), position);
        const applyPosition = () => {
            if (view.getMode() !== 'source') return;
            const editorView = this.codeMirrorView(view);
            if (!editorView) return;
            const line = editorView.state.doc.line(Math.max(
                1,
                Math.min(editorView.state.doc.lines, lineNumber + 1)
            ));
            editorView.dispatch({
                effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 24 })
            });
            editorView.requestMeasure({
                key: this,
                read: measuredView => {
                    const coordinates = measuredView.coordsAtPos(line.from);
                    const viewportTop = measuredView.scrollDOM.getBoundingClientRect().top;
                    return coordinates ? coordinates.top - viewportTop - 24 : null;
                },
                write: (delta, measuredView) => {
                    if (delta === null || view.getMode() !== 'source') return;
                    measuredView.scrollDOM.scrollTop = Math.max(
                        0,
                        measuredView.scrollDOM.scrollTop + delta
                    );
                }
            });
        };
        applyPosition();
        // Obsidian applies its own mode-scroll state shortly after mounting
        // CodeMirror. Reassert once after that handoff, before a user could
        // reasonably begin scrolling, so the semantic anchor wins the race.
        await new Promise<void>(resolve => ownerWindow.setTimeout(resolve, 120));
        applyPosition();
    }

    private positionForSourceLine(source: string, line: number): ReadingDocumentPosition {
        const lines = source.split('\n');
        const lastLine = Math.max(0, lines.length - 1);
        const target = Math.max(0, Math.min(lastLine, line));
        const headings = this.sourceHeadingLines(lines);
        let headingIndex = -1;
        for (let index = 0; index < headings.length; index += 1) {
            if (headings[index] > target) break;
            headingIndex = index;
        }
        const sectionStart = headingIndex >= 0 ? headings[headingIndex] : 0;
        const sectionEnd = headings[headingIndex + 1] ?? lastLine;
        const sectionFraction = sectionEnd > sectionStart
            ? (target - sectionStart) / (sectionEnd - sectionStart)
            : 0;
        return {
            progress: lastLine ? target / lastLine : 0,
            headingIndex,
            sectionFraction: Math.max(0, Math.min(1, sectionFraction)),
            anchorText: lines[target]?.trim().slice(0, 240)
        };
    }

    private sourceLineForPosition(source: string, position: ReadingDocumentPosition): number {
        const lines = source.split('\n');
        const lastLine = Math.max(0, lines.length - 1);
        if (position.anchorText) {
            const anchoredLine = lines.findIndex(line => anchorTextsMatch(position.anchorText ?? '', line));
            if (anchoredLine >= 0) return anchoredLine;
        }
        const headings = this.sourceHeadingLines(lines);
        if (position.headingIndex < -1 || position.headingIndex >= headings.length) {
            return Math.round(Math.max(0, Math.min(1, position.progress)) * lastLine);
        }
        const sectionStart = position.headingIndex >= 0 ? headings[position.headingIndex] : 0;
        const sectionEnd = headings[position.headingIndex + 1] ?? lastLine;
        return Math.round(
            sectionStart
            + Math.max(0, Math.min(1, position.sectionFraction)) * Math.max(0, sectionEnd - sectionStart)
        );
    }

    private sourceHeadingLines(lines: string[]): number[] {
        const headings: number[] = [];
        let fence: '`' | '~' | null = null;
        let frontmatter = lines[0]?.trim() === '---';
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            if (frontmatter) {
                if (index > 0 && line.trim() === '---') frontmatter = false;
                continue;
            }
            const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
            if (fenceMatch) {
                const marker = fenceMatch[1][0] as '`' | '~';
                if (fence === marker) fence = null;
                else if (fence === null) fence = marker;
                continue;
            }
            if (fence) continue;
            if (/^ {0,3}#{1,6}(?:\s+|$)/.test(line)) headings.push(index);
            else if (
                line.trim()
                && index + 1 < lines.length
                && /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1])
            ) {
                headings.push(index);
            }
        }
        return headings;
    }

    private codeMirrorView(view: MarkdownView): EditorView | null {
        return (view.editor as typeof view.editor & { cm?: EditorView }).cm ?? null;
    }

    private themeIsActive(root: HTMLElement): boolean {
        return root.ownerDocument.defaultView
            ?.getComputedStyle(root)
            .getPropertyValue('--mms-theme-active')
            .trim() === '1';
    }
}
