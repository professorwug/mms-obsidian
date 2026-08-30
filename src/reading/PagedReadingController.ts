import { anchorTextsMatch, findBestAnchorElement } from './position';
import { setIcon } from 'obsidian';

const OWNED_SELECTOR = '[data-mms-owned="pagination"]';

interface LayoutMeasurement {
    durationMs: number;
    readMs: number;
    writeMs: number;
    blocks: number;
    spacers: number;
}

export interface PagedTransitionPerformance {
    fromPage: number;
    toPage: number;
    inputToAnimationMs: number;
    captureCurrentMs: number;
    composeMs: number;
    captureDestinationMs: number;
    animationMs: number;
    totalMs: number;
    frames: number;
    droppedFrames: number;
    longestFrameMs: number;
    mutationBatches: number;
    mutationNodes: number;
    animationMutationNodes: number;
    layout: LayoutMeasurement | null;
    preCleanupErrorPx: number;
    postLayoutErrorPx: number;
    finalErrorPx: number;
}

export interface ReadingDocumentPosition {
    progress: number;
    headingIndex: number;
    sectionFraction: number;
    anchorText?: string;
    highlightAnchorText?: string;
    highlightProgress?: number;
}

/**
 * Adds persistent page boundaries to a complete, plugin-owned Reading render.
 * The outer Obsidian preview remains the native scroll container, while all
 * measured blocks and page breaks live in a stable document beneath it.
 */
export class PagedReadingController {
    private toolbar: HTMLElement | null = null;
    private toggleButton: HTMLButtonElement | null = null;
    private previousButton: HTMLButtonElement | null = null;
    private nextButton: HTMLButtonElement | null = null;
    private status: HTMLButtonElement | null = null;
    private tocPopover: HTMLElement | null = null;
    private content: HTMLElement | null = null;
    private active = false;
    private initialized = false;
    private busy = false;
    private layoutTimer: number | null = null;
    private scrollEndTimer: number | null = null;
    private reflowFrame: number | null = null;
    private navigationFrame: number | null = null;
    private highlightTimer: number | null = null;
    private layoutPending = false;
    private navigationTarget: number | null = null;
    private activationPosition: ReadingDocumentPosition | null = null;
    private pageCount = 1;
    private pageOrigin = 0;
    private pageTopSpace = 72;
    private pageBottomSpace = 96;

    private readonly onScroll = () => this.handleScroll();
    private readonly onKeyDown = (event: KeyboardEvent) => this.handleKeyDown(event);
    private readonly onDocumentPointerDown = (event: PointerEvent) => {
        const target = event.target as Node | null;
        if (target && !this.toolbar?.contains(target)) this.closeTableOfContents();
    };

    constructor(
        private readonly readingView: HTMLElement,
        private readonly preview: HTMLElement,
        private readonly requestActive: (active: boolean) => Promise<void>,
        private readonly positionChanged: (position: ReadingDocumentPosition) => void = () => {},
        private readonly layoutChanged: () => void = () => {}
    ) {}

    setAvailable(available: boolean, activeByDefault: boolean): void {
        if (!available) {
            if (this.active) void this.requestMode(false);
            this.removeToolbar();
            this.initialized = false;
            return;
        }
        this.ensureToolbar();
        if (!this.initialized) {
            this.initialized = true;
            if (activeByDefault) void this.requestMode(true);
        }
    }

    toggle(): boolean {
        if (!this.toolbar || this.busy) return this.active;
        const target = !this.active;
        void this.requestMode(target);
        return target;
    }

    activate(content: HTMLElement, initialPosition: ReadingDocumentPosition): void {
        if (this.active) this.deactivate();
        this.content = content;
        this.activationPosition = initialPosition;
        this.active = true;
        this.readingView.classList.add('mms-reading-pane', 'mms-paged-reading-active');
        this.preview.classList.add('mms-paged-reading-active');
        this.preview.addEventListener('scroll', this.onScroll, { passive: true });
        this.preview.ownerDocument.addEventListener('keydown', this.onKeyDown, true);
        this.toggleButton?.classList.add('is-active');
        this.toggleButton?.setAttribute('aria-pressed', 'true');
        this.layout();
    }

    deactivate(): ReadingDocumentPosition {
        const position = this.capturePosition();
        this.cancelScheduledWork();
        if (this.active) {
            this.preview.removeEventListener('scroll', this.onScroll);
            this.preview.ownerDocument.removeEventListener('keydown', this.onKeyDown, true);
        }
        this.active = false;
        this.content?.classList.remove('is-ready');
        this.readingView.classList.remove('mms-paged-reading-active');
        this.preview.classList.remove(
            'mms-paged-reading-active',
            'mms-pagination-navigating',
            'mms-pagination-reflowing'
        );
        this.preview.style.removeProperty('--mms-page-height');
        this.preview.style.removeProperty('--mms-page-top');
        this.preview.style.removeProperty('--mms-page-bottom');
        this.preview.style.removeProperty('--mms-page-usable');
        this.removeArtifacts();
        this.content = null;
        this.navigationTarget = null;
        this.activationPosition = null;
        this.pageCount = 1;
        this.toggleButton?.classList.remove('is-active');
        this.toggleButton?.setAttribute('aria-pressed', 'false');
        this.updateControls();
        return position;
    }

    capturePosition(): ReadingDocumentPosition {
        const content = this.content;
        if (!this.active || !content?.isConnected) {
            return { progress: 0, headingIndex: -1, sectionFraction: 0 };
        }
        const contentRect = content.getBoundingClientRect();
        const readingTop = this.preview.getBoundingClientRect().top + this.pageTopSpace;
        const contentHeight = Math.max(1, content.scrollHeight, contentRect.height);
        const y = Math.max(0, Math.min(contentHeight, readingTop - contentRect.top));
        const headings = this.headingPositions(content);
        const anchor = this.collectBlocks(content).find(block => {
            const rect = block.getBoundingClientRect();
            return rect.bottom > readingTop + 1 && rect.top < this.preview.getBoundingClientRect().bottom;
        });
        let headingIndex = -1;
        for (let index = 0; index < headings.length; index += 1) {
            if (headings[index] > y) break;
            headingIndex = index;
        }
        const sectionStart = headingIndex >= 0 ? headings[headingIndex] : 0;
        const sectionEnd = headings[headingIndex + 1] ?? contentHeight;
        const sectionFraction = sectionEnd > sectionStart
            ? (y - sectionStart) / (sectionEnd - sectionStart)
            : 0;
        return {
            progress: Math.max(0, Math.min(1, y / contentHeight)),
            headingIndex,
            sectionFraction: Math.max(0, Math.min(1, sectionFraction)),
            anchorText: anchor?.textContent?.trim().slice(0, 240)
        };
    }

    isActive(): boolean {
        return this.active;
    }

    getPerformanceSamples(): PagedTransitionPerformance[] {
        return [];
    }

    scheduleLayout(): void {
        if (!this.active || !this.content) return;
        const ownerWindow = this.ownerWindow();
        if (this.scrollEndTimer !== null) {
            this.layoutPending = true;
            return;
        }
        if (this.layoutTimer !== null) ownerWindow.clearTimeout(this.layoutTimer);
        this.layoutTimer = ownerWindow.setTimeout(() => {
            this.layoutTimer = null;
            this.layout();
        }, 80);
    }

    destroy(): void {
        this.deactivate();
        this.removeToolbar();
    }

    private async requestMode(active: boolean): Promise<void> {
        if (this.busy || active === this.active) return;
        this.busy = true;
        this.updateControls();
        try {
            await this.requestActive(active);
        } finally {
            this.busy = false;
            this.updateControls();
        }
    }

    private ensureToolbar(): void {
        if (this.toolbar?.isConnected) return;
        const toolbar = this.preview.ownerDocument.createElement('div');
        toolbar.className = 'mms-page-controls';
        toolbar.dataset.mmsOwned = 'pagination';
        toolbar.setAttribute('role', 'toolbar');
        toolbar.setAttribute('aria-label', 'Paged reading controls');
        this.toggleButton = this.button('Toggle paged view', '');
        setIcon(this.toggleButton, 'book-open');
        this.previousButton = this.button('Previous page', '←');
        this.status = this.preview.ownerDocument.createElement('button');
        this.status.type = 'button';
        this.status.className = 'clickable-icon mms-page-status';
        this.status.setAttribute('aria-label', 'Table of contents');
        this.status.setAttribute('aria-haspopup', 'menu');
        this.status.setAttribute('aria-expanded', 'false');
        this.status.setAttribute('aria-live', 'polite');
        this.nextButton = this.button('Next page', '→');
        this.toggleButton.addEventListener('click', () => this.toggle());
        this.previousButton.addEventListener('click', () => this.turnPage(-1));
        this.status.addEventListener('click', () => this.toggleTableOfContents());
        this.nextButton.addEventListener('click', () => this.turnPage(1));
        toolbar.append(this.toggleButton, this.previousButton, this.status, this.nextButton);
        this.readingView.appendChild(toolbar);
        this.toolbar = toolbar;
        this.updateControls();
    }

    private button(label: string, text: string): HTMLButtonElement {
        const button = this.preview.ownerDocument.createElement('button');
        button.type = 'button';
        button.className = 'clickable-icon mms-page-button';
        button.setAttribute('aria-label', label);
        button.title = label;
        button.textContent = text;
        return button;
    }

    private removeToolbar(): void {
        this.closeTableOfContents();
        this.toolbar?.remove();
        this.toolbar = null;
        this.toggleButton = null;
        this.previousButton = null;
        this.nextButton = null;
        this.status = null;
    }

    private layout(): LayoutMeasurement | null {
        const content = this.content;
        if (!this.active || !content?.isConnected || this.preview.clientHeight < 200) return null;
        const performance = this.ownerWindow().performance;
        const startedAt = performance.now();
        const preservedPage = this.navigationTarget ?? this.currentPage();
        const ownerWindow = this.ownerWindow();
        this.preview.classList.add('mms-pagination-reflowing');
        this.removeCompositionArtifacts();
        const pageHeight = this.preview.clientHeight;
        const compact = this.preview.clientWidth < 700;
        const shortViewport = pageHeight < 600;
        this.pageTopSpace = shortViewport ? 32 : (compact ? 48 : 72);
        this.pageBottomSpace = shortViewport ? 68 : (compact ? 76 : 96);
        this.pageOrigin = content.offsetTop;
        this.preview.style.setProperty('--mms-page-height', `${pageHeight}px`);
        this.preview.style.setProperty('--mms-page-top', `${this.pageTopSpace}px`);
        this.preview.style.setProperty('--mms-page-bottom', `${this.pageBottomSpace}px`);
        this.preview.style.setProperty('--mms-page-usable', `${pageHeight - this.pageTopSpace - this.pageBottomSpace}px`);
        const usableHeight = pageHeight - this.pageTopSpace - this.pageBottomSpace;
        const blocks = this.collectBlocks(content);

        const readStartedAt = performance.now();
        const contentTop = content.getBoundingClientRect().top;
        const measurements = blocks.map(block => {
            if (!block.isConnected || block.offsetParent === null) return null;
            const rect = block.getBoundingClientRect();
            return {
                block,
                y: rect.top - contentTop,
                height: rect.height,
                isHeading: block.matches('h1, h2, h3, h4, h5, h6') || Boolean(block.querySelector(
                    ':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6'
                ))
            };
        });
        const readMs = performance.now() - readStartedAt;

        let cumulativeSpacerHeight = 0;
        const placements: Array<{ block: HTMLElement; height: number }> = [];
        measurements.forEach((measurement, index) => {
            if (!measurement) return;
            const adjustedY = measurement.y + cumulativeSpacerHeight;
            const localY = ((adjustedY % pageHeight) + pageHeight) % pageHeight;
            const nextHeight = measurement.isHeading ? measurements[index + 1]?.height ?? 0 : 0;
            const groupedHeight = measurement.height + nextHeight;
            if (localY + groupedHeight <= usableHeight || groupedHeight > usableHeight) return;
            const spacerHeight = Math.max(0, pageHeight - localY);
            placements.push({ block: measurement.block, height: spacerHeight });
            cumulativeSpacerHeight += spacerHeight;
        });

        const writeStartedAt = performance.now();
        const spacers = placements.map(placement => {
            const spacer = this.preview.ownerDocument.createElement('div');
            spacer.className = 'mms-page-spacer';
            spacer.dataset.mmsOwned = 'pagination';
            spacer.style.height = `${placement.height}px`;
            placement.block.insertAdjacentElement('beforebegin', spacer);
            return spacer;
        });
        spacers.forEach(spacer => this.alignSpacerToBoundary(spacer, content, pageHeight));
        const contentHeight = Math.max(content.scrollHeight, content.getBoundingClientRect().height);
        this.pageCount = Math.max(1, Math.ceil(contentHeight / pageHeight));
        this.syncSnapLayer(pageHeight);
        this.buildTableOfContents(content, pageHeight);

        const activationPosition = this.activationPosition;
        const restoredPage = activationPosition === null
            ? Math.max(0, Math.min(this.pageCount - 1, preservedPage))
            : this.pageForPosition(activationPosition, content, pageHeight);
        this.activationPosition = null;
        this.preview.scrollTo({ top: this.pageScrollTop(restoredPage), behavior: 'auto' });
        content.classList.add('is-ready');
        this.layoutChanged();
        if (activationPosition) this.flashPosition(activationPosition, content);
        this.updateControls();
        this.positionChanged(this.capturePosition());
        if (this.reflowFrame !== null) ownerWindow.cancelAnimationFrame(this.reflowFrame);
        this.reflowFrame = ownerWindow.requestAnimationFrame(() => {
            this.reflowFrame = null;
            this.preview.classList.remove('mms-pagination-reflowing');
        });
        const writeMs = performance.now() - writeStartedAt;
        return {
            durationMs: performance.now() - startedAt,
            readMs,
            writeMs,
            blocks: measurements.filter(Boolean).length,
            spacers: placements.length
        };
    }

    private collectBlocks(content: HTMLElement): HTMLElement[] {
        const sections = Array.from(content.querySelectorAll<HTMLElement>(':scope > .markdown-preview-section'));
        const blocks = sections.flatMap(section => (Array.from(section.children) as HTMLElement[])
            .filter(element => this.isLayoutBlock(element)));
        return blocks.length
            ? blocks
            : (Array.from(content.children) as HTMLElement[]).filter(element => this.isLayoutBlock(element));
    }

    private isLayoutBlock(element: HTMLElement): boolean {
        return !element.matches('.markdown-preview-pusher, .mod-ui, .footnotes, [data-mms-owned]');
    }

    private alignSpacerToBoundary(spacer: HTMLElement, content: HTMLElement, pageHeight: number): void {
        const contentTop = content.getBoundingClientRect().top;
        const rect = spacer.getBoundingClientRect();
        const end = rect.top - contentTop + rect.height;
        const remainder = ((end % pageHeight) + pageHeight) % pageHeight;
        const correction = remainder <= pageHeight / 2 ? -remainder : pageHeight - remainder;
        if (Math.abs(correction) < 0.1) return;
        const currentHeight = Number.parseFloat(spacer.style.height) || rect.height;
        spacer.style.height = `${Math.max(0, currentHeight + correction)}px`;
    }

    private headingPositions(content: HTMLElement): number[] {
        const contentTop = content.getBoundingClientRect().top;
        return this.collectBlocks(content)
            .filter(block => block.matches('h1, h2, h3, h4, h5, h6') || Boolean(block.querySelector(
                ':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6'
            )))
            .map(block => block.getBoundingClientRect().top - contentTop);
    }

    private pageForPosition(
        position: ReadingDocumentPosition,
        content: HTMLElement,
        pageHeight: number
    ): number {
        const headings = this.headingPositions(content);
        const contentHeight = Math.max(1, content.scrollHeight, content.getBoundingClientRect().height);
        let y = position.progress * contentHeight;
        const anchorBlock = position.anchorText
            ? this.collectBlocks(content).find(block => anchorTextsMatch(
                position.anchorText ?? '',
                block.textContent ?? ''
            ))
            : null;
        if (anchorBlock) {
            y = anchorBlock.getBoundingClientRect().top - content.getBoundingClientRect().top;
        } else if (position.headingIndex >= -1 && position.headingIndex < headings.length) {
            const sectionStart = position.headingIndex >= 0 ? headings[position.headingIndex] : 0;
            const sectionEnd = headings[position.headingIndex + 1] ?? contentHeight;
            y = sectionStart + position.sectionFraction * Math.max(0, sectionEnd - sectionStart);
        }
        return Math.max(0, Math.min(this.pageCount - 1, Math.floor(y / pageHeight)));
    }

    private flashPosition(position: ReadingDocumentPosition, content: HTMLElement): void {
        const anchorText = position.highlightAnchorText ?? position.anchorText;
        if (!anchorText) return;
        const target = findBestAnchorElement(
            anchorText,
            this.collectAnchorTargets(content),
            position.highlightProgress ?? position.progress
        );
        if (!target) return;
        const ownerWindow = this.ownerWindow();
        if (this.highlightTimer !== null) ownerWindow.clearTimeout(this.highlightTimer);
        content.querySelectorAll('.mms-reading-return-target').forEach(element => {
            element.classList.remove('mms-reading-return-target');
        });
        ownerWindow.requestAnimationFrame(() => target.classList.add('mms-reading-return-target'));
        this.highlightTimer = ownerWindow.setTimeout(() => {
            this.highlightTimer = null;
            target.classList.remove('mms-reading-return-target');
        }, 2200);
    }

    private collectAnchorTargets(content: HTMLElement): HTMLElement[] {
        return Array.from(content.querySelectorAll<HTMLElement>(
            'h1, h2, h3, h4, h5, h6, p, li, blockquote'
        )).filter(element => !element.closest('[data-mms-owned]'));
    }

    private buildTableOfContents(content: HTMLElement, pageHeight: number): void {
        if (!this.tocPopover) return;
        this.populateTableOfContents(this.tocPopover, content, pageHeight);
    }

    private toggleTableOfContents(): void {
        if (this.tocPopover) {
            this.closeTableOfContents();
            return;
        }
        const content = this.content;
        const toolbar = this.toolbar;
        if (!content || !toolbar || !this.active) return;
        const popover = this.preview.ownerDocument.createElement('nav');
        popover.className = 'mms-toc-popover';
        popover.dataset.mmsOwned = 'pagination';
        popover.setAttribute('aria-label', 'Table of contents');
        popover.setAttribute('role', 'menu');
        this.populateTableOfContents(popover, content, this.preview.clientHeight);
        toolbar.appendChild(popover);
        this.tocPopover = popover;
        this.status?.setAttribute('aria-expanded', 'true');
        this.preview.ownerDocument.addEventListener('pointerdown', this.onDocumentPointerDown, true);
    }

    private populateTableOfContents(
        popover: HTMLElement,
        content: HTMLElement,
        pageHeight: number
    ): void {
        popover.replaceChildren();
        const headings = this.collectBlocks(content).flatMap(block => {
            const heading = block.matches('h1, h2, h3, h4, h5, h6')
                ? block
                : block.querySelector<HTMLElement>('h1, h2, h3, h4, h5, h6');
            return heading ? [{ block, heading }] : [];
        });
        if (!headings.length) {
            const empty = this.preview.ownerDocument.createElement('span');
            empty.className = 'mms-toc-empty';
            empty.textContent = 'No headings';
            popover.appendChild(empty);
            return;
        }
        for (const { block, heading } of headings) {
            const button = this.preview.ownerDocument.createElement('button');
            button.type = 'button';
            button.className = 'mms-toc-item';
            button.setAttribute('role', 'menuitem');
            const depth = Math.max(1, Number.parseInt(heading.tagName.slice(1), 10) || 1);
            button.style.paddingLeft = `${0.55 + (depth - 1) * 0.8}rem`;
            button.textContent = heading.textContent?.trim() || 'Untitled section';
            button.addEventListener('click', () => {
                const y = block.getBoundingClientRect().top - content.getBoundingClientRect().top;
                const page = Math.max(0, Math.min(this.pageCount - 1, Math.floor(y / pageHeight)));
                this.closeTableOfContents();
                this.goToPage(page);
            });
            popover.appendChild(button);
        }
    }

    private closeTableOfContents(): void {
        this.preview.ownerDocument.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
        this.tocPopover?.remove();
        this.tocPopover = null;
        this.status?.setAttribute('aria-expanded', 'false');
    }

    private syncSnapLayer(pageHeight: number): void {
        let markers = Array.from(this.preview.querySelectorAll<HTMLElement>(':scope > .mms-page-marker'));
        if (markers.length !== this.pageCount) {
            markers.forEach(marker => marker.remove());
            const fragment = this.preview.ownerDocument.createDocumentFragment();
            markers = Array.from({ length: this.pageCount }, (_, page) => {
                const marker = this.preview.ownerDocument.createElement('span');
                marker.className = 'mms-page-marker';
                marker.dataset.mmsOwned = 'pagination';
                marker.dataset.page = String(page + 1);
                marker.setAttribute('aria-hidden', 'true');
                fragment.appendChild(marker);
                return marker;
            });
            this.preview.appendChild(fragment);
        }
        markers.forEach((marker, page) => {
            marker.style.top = `${this.pageOrigin + page * pageHeight}px`;
        });
        let extent = this.preview.querySelector<HTMLElement>(':scope > .mms-page-extent');
        if (!extent) {
            extent = this.preview.ownerDocument.createElement('span');
            extent.className = 'mms-page-extent';
            extent.dataset.mmsOwned = 'pagination';
            extent.setAttribute('aria-hidden', 'true');
            this.preview.appendChild(extent);
        }
        extent.style.top = `${this.pageOrigin + this.pageCount * pageHeight - this.pageTopSpace}px`;
    }

    private removeArtifacts(): void {
        this.preview.querySelectorAll(OWNED_SELECTOR).forEach(element => {
            if (element !== this.toolbar) element.remove();
        });
    }

    private removeCompositionArtifacts(): void {
        this.content?.querySelectorAll(
            '.mms-page-spacer[data-mms-owned="pagination"], .mms-page-tail[data-mms-owned="pagination"]'
        ).forEach(element => element.remove());
    }

    private handleScroll(): void {
        this.updateControls();
        if (!this.active) return;
        this.positionChanged(this.capturePosition());
        const ownerWindow = this.ownerWindow();
        if (this.scrollEndTimer !== null) ownerWindow.clearTimeout(this.scrollEndTimer);
        this.scrollEndTimer = ownerWindow.setTimeout(() => {
            this.scrollEndTimer = null;
            if (this.navigationTarget !== null) this.finishNavigation();
            if (this.layoutPending) {
                this.layoutPending = false;
                this.scheduleLayout();
            }
            this.positionChanged(this.capturePosition());
        }, 220);
    }

    private handleKeyDown(event: KeyboardEvent): void {
        if (event.key === 'Escape' && this.tocPopover) {
            event.preventDefault();
            this.closeTableOfContents();
            this.status?.focus();
            return;
        }
        if (!this.active || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
        const target = event.target as HTMLElement | null;
        if (!target || !this.readingView.closest('.workspace-leaf.mod-active')) return;
        const key = ({
            UIKeyInputUpArrow: 'ArrowUp',
            UIKeyInputDownArrow: 'ArrowDown',
            UIKeyInputLeftArrow: 'ArrowLeft',
            UIKeyInputRightArrow: 'ArrowRight'
        } as Record<string, string>)[event.key]
            ?? (event.key && event.key !== 'Unidentified' ? event.key : event.code);
        const isArrow = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key);
        const readerControl = Boolean(target.closest('.mms-page-controls'));
        const interactive = Boolean(target.closest(
            'a, button, input, textarea, select, summary, details, [contenteditable="true"], iframe, pre, table, [role="dialog"]'
        ));
        if (interactive && !(isArrow && readerControl)) return;
        const forward = key === 'PageDown' || key === 'ArrowDown' || key === 'ArrowRight'
            || (key === ' ' && !event.shiftKey);
        const backward = key === 'PageUp' || key === 'ArrowUp' || key === 'ArrowLeft'
            || (key === ' ' && event.shiftKey);
        if (!forward && !backward) return;
        event.preventDefault();
        this.turnPage(forward ? 1 : -1);
    }

    private turnPage(delta: number): void {
        if (!this.active) return;
        const current = this.navigationTarget ?? this.currentPage();
        const destination = Math.max(0, Math.min(this.pageCount - 1, current + delta));
        if (destination === current) return;
        this.goToPage(destination);
    }

    private goToPage(destination: number): void {
        if (!this.active) return;
        this.navigationTarget = Math.max(0, Math.min(this.pageCount - 1, destination));
        this.preview.classList.add('mms-pagination-navigating');
        this.preview.scrollTo({
            top: this.pageScrollTop(this.navigationTarget),
            behavior: this.scrollBehavior()
        });
        this.updateControls();
    }

    private finishNavigation(): void {
        const page = this.navigationTarget;
        if (page === null) return;
        const ownerWindow = this.ownerWindow();
        this.preview.scrollTo({ top: this.pageScrollTop(page), behavior: 'auto' });
        if (this.navigationFrame !== null) ownerWindow.cancelAnimationFrame(this.navigationFrame);
        this.navigationFrame = ownerWindow.requestAnimationFrame(() => {
            this.navigationFrame = null;
            this.preview.classList.remove('mms-pagination-navigating');
            this.navigationTarget = null;
            this.updateControls();
        });
    }

    private pageScrollTop(page: number): number {
        return Math.max(0, this.pageOrigin + page * this.preview.clientHeight - this.pageTopSpace);
    }

    private currentPage(): number {
        if (!this.active || !this.preview.clientHeight) return 0;
        return Math.max(0, Math.min(
            this.pageCount - 1,
            Math.round(Math.max(0, this.preview.scrollTop + this.pageTopSpace - this.pageOrigin)
                / this.preview.clientHeight)
        ));
    }

    private scrollBehavior(): ScrollBehavior {
        return this.ownerWindow().matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    }

    private updateControls(): void {
        const page = this.navigationTarget ?? this.currentPage();
        if (this.status) this.status.textContent = `${page + 1} / ${this.pageCount}`;
        if (this.toggleButton) {
            this.toggleButton.disabled = this.busy;
            this.toggleButton.setAttribute('aria-pressed', String(this.active));
        }
        if (this.previousButton) this.previousButton.disabled = this.busy || !this.active || page <= 0;
        if (this.nextButton) this.nextButton.disabled = this.busy || !this.active || page >= this.pageCount - 1;
    }

    private cancelScheduledWork(): void {
        const ownerWindow = this.ownerWindow();
        this.closeTableOfContents();
        if (this.layoutTimer !== null) ownerWindow.clearTimeout(this.layoutTimer);
        if (this.scrollEndTimer !== null) ownerWindow.clearTimeout(this.scrollEndTimer);
        if (this.reflowFrame !== null) ownerWindow.cancelAnimationFrame(this.reflowFrame);
        if (this.navigationFrame !== null) ownerWindow.cancelAnimationFrame(this.navigationFrame);
        if (this.highlightTimer !== null) ownerWindow.clearTimeout(this.highlightTimer);
        this.layoutTimer = null;
        this.scrollEndTimer = null;
        this.reflowFrame = null;
        this.navigationFrame = null;
        this.highlightTimer = null;
        this.content?.querySelectorAll('.mms-reading-return-target').forEach(element => {
            element.classList.remove('mms-reading-return-target');
        });
        this.layoutPending = false;
    }

    private ownerWindow(): Window {
        return this.preview.ownerDocument.defaultView ?? window;
    }
}
