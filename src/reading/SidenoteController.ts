interface SidenoteRecord {
    source: HTMLLIElement;
    refs: HTMLAnchorElement[];
    originalHrefs: string[];
    renderedId: string;
}

/**
 * Projects Obsidian's standard Reading-view footnote DOM into a margin rail.
 * The source endnotes remain untouched and are merely hidden while the
 * projection is complete, so a re-render can always fall back safely.
 */
export class SidenoteController {
    private records: SidenoteRecord[] = [];
    private sourceContainers = new Set<HTMLElement>();
    private ownedElements: HTMLElement[] = [];
    private narrow = false;
    private popover: HTMLElement | null = null;
    private readonly onClick = (event: MouseEvent) => this.handleClick(event);
    private readonly onScroll = () => this.closePopover();
    private readonly onDocumentPointerDown = (event: PointerEvent) => {
        const target = event.target as Element | null;
        if (!target?.closest('.mms-sidenote-popover, a[data-mms-sidenote-target]')) this.closePopover();
    };
    private readonly onDocumentKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && this.popover) {
            event.preventDefault();
            this.closePopover();
        }
    };

    constructor(private readonly preview: HTMLElement) {
        preview.addEventListener('click', this.onClick);
        preview.addEventListener('scroll', this.onScroll, { passive: true });
        preview.ownerDocument.addEventListener('pointerdown', this.onDocumentPointerDown, true);
        preview.ownerDocument.addEventListener('keydown', this.onDocumentKeyDown, true);
    }

    sync(enabled: boolean, content?: HTMLElement): void {
        this.reset();
        if (!enabled) return;

        const sizer = content ?? this.preview.querySelector<HTMLElement>(
            ':scope > .markdown-preview-sizer:not(.mms-paged-document)'
        );
        if (!sizer) return;

        const refs = Array.from(sizer.querySelectorAll<HTMLAnchorElement>(
            'sup.footnote-ref a.footnote-link[href*="#"], a.footnote-link[data-footref][href*="#"]'
        )).filter(ref => !ref.closest('[data-mms-owned]'));
        const notes = Array.from(sizer.querySelectorAll<HTMLLIElement>(
            'li[id^="fn-"], li[data-footnote-id]'
        )).filter(note => !note.closest('[data-mms-owned]'));

        if (!refs.length || !notes.length) return;

        const byId = new Map<string, HTMLLIElement>();
        notes.forEach(note => {
            if (note.id) byId.set(note.id, note);
            const dataId = note.dataset.footnoteId;
            if (dataId) byId.set(dataId, note);
        });
        const grouped = new Map<HTMLLIElement, HTMLAnchorElement[]>();

        for (const ref of refs) {
            const id = this.hashTarget(ref.getAttribute('href'));
            const note = id ? byId.get(id) : undefined;
            if (!note) return; // all-or-nothing: preserve native endnotes
            const noteRefs = grouped.get(note) ?? [];
            noteRefs.push(ref);
            grouped.set(note, noteRefs);
        }

        if (grouped.size !== notes.length) return;

        let sequence = 0;
        for (const [source, noteRefs] of grouped) {
            const renderedId = `mms-sidenote-${source.id || ++sequence}`;
            this.records.push({
                source,
                refs: noteRefs,
                originalHrefs: noteRefs.map(ref => ref.getAttribute('href') ?? ''),
                renderedId
            });
        }

        const sizerRect = sizer.getBoundingClientRect();
        const previewRect = this.preview.getBoundingClientRect();
        if (this.preview.clientWidth <= 0 || sizerRect.width <= 0) return;
        const rootFontSize = Number.parseFloat(
            this.preview.ownerDocument.defaultView?.getComputedStyle(this.preview).fontSize ?? ''
        ) || 16;
        const railGap = rootFontSize * 2;
        const available = previewRect.right - sizerRect.right - railGap - 8;
        this.narrow = this.preview.clientWidth <= 760 || available < 180;

        for (const record of this.records) {
            const source = record.source.closest<HTMLElement>('section.footnotes, .footnotes')
                ?? record.source.parentElement;
            if (source) this.sourceContainers.add(source);
            record.refs.forEach(ref => {
                ref.setAttribute('href', `#${record.renderedId}`);
                ref.dataset.mmsSidenoteTarget = record.renderedId;
            });
        }

        if (this.narrow) this.preparePopovers();
        else this.renderRail(sizer, available);

        this.sourceContainers.forEach(source => source.classList.add('mms-footnote-source'));
        this.preview.classList.add(this.narrow ? 'mms-sidenotes-narrow' : 'mms-sidenotes-wide');
    }

    destroy(): void {
        this.reset();
        this.preview.removeEventListener('click', this.onClick);
        this.preview.removeEventListener('scroll', this.onScroll);
        this.preview.ownerDocument.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
        this.preview.ownerDocument.removeEventListener('keydown', this.onDocumentKeyDown, true);
    }

    private renderRail(sizer: HTMLElement, available: number): void {
        const rail = this.preview.ownerDocument.createElement('aside');
        rail.className = 'mms-sidenote-rail';
        rail.dataset.mmsOwned = 'sidenotes';
        rail.setAttribute('aria-label', 'Sidenotes');
        rail.style.setProperty('--mms-sidenote-width', `${Math.min(280, Math.floor(available))}px`);
        rail.style.height = `${Math.max(sizer.scrollHeight, sizer.getBoundingClientRect().height)}px`;

        const list = this.preview.ownerDocument.createElement('ol');
        rail.appendChild(list);
        sizer.appendChild(rail);
        this.ownedElements.push(rail);

        const sizerTop = sizer.getBoundingClientRect().top;
        const pageHeight = this.preview.classList.contains('mms-paged-reading-active')
            ? this.preview.clientHeight
            : 0;
        const styles = this.preview.ownerDocument.defaultView?.getComputedStyle(this.preview);
        const pageTop = Number.parseFloat(styles?.getPropertyValue('--mms-page-top') ?? '') || 72;
        const pageBottom = Number.parseFloat(styles?.getPropertyValue('--mms-page-bottom') ?? '') || 96;
        let bottom = 0;
        for (const record of this.records) {
            const item = this.cloneNote(record);
            list.appendChild(item);
            const desired = Math.max(0, record.refs[0].getBoundingClientRect().top - sizerTop);
            const height = item.getBoundingClientRect().height;
            let top = Math.max(desired, bottom + 12);
            if (pageHeight > 0 && height < pageHeight - pageTop - pageBottom) {
                const page = Math.max(0, Math.floor(top / pageHeight));
                const pageEnd = (page + 1) * pageHeight - pageBottom;
                if (top + height > pageEnd) {
                    top = Math.max(bottom + 12, (page + 1) * pageHeight + pageTop);
                }
            }
            item.style.top = `${top}px`;
            bottom = top + height;
        }
    }

    private preparePopovers(): void {
        for (const record of this.records) {
            record.refs.forEach(ref => {
                ref.setAttribute('aria-controls', record.renderedId);
                ref.setAttribute('aria-expanded', 'false');
                ref.setAttribute('aria-haspopup', 'dialog');
            });
        }
    }

    private cloneNote(record: SidenoteRecord, keepId = true): HTMLLIElement {
        const clone = record.source.cloneNode(true) as HTMLLIElement;
        clone.classList.add('mms-sidenote');
        clone.removeAttribute('data-footnote-id');
        clone.querySelectorAll('.footnote-backref').forEach(backref => backref.remove());
        if (keepId) clone.id = record.renderedId;
        else clone.removeAttribute('id');
        return clone;
    }

    private handleClick(event: MouseEvent): void {
        if (!this.narrow) return;
        const target = event.target as Element | null;
        const ref = target?.closest<HTMLAnchorElement>('a[data-mms-sidenote-target]');
        if (!ref || !this.preview.contains(ref)) return;

        const id = ref.dataset.mmsSidenoteTarget;
        event.preventDefault();
        const record = this.records.find(candidate => candidate.renderedId === id);
        if (!record) return;
        if (this.popover?.id === record.renderedId) {
            this.closePopover();
            return;
        }
        this.showPopover(record, ref);
    }

    private showPopover(record: SidenoteRecord, ref: HTMLAnchorElement): void {
        this.closePopover();
        const document = this.preview.ownerDocument;
        const popover = document.createElement('aside');
        popover.className = 'mms-sidenote-popover';
        popover.dataset.mmsOwned = 'sidenotes';
        popover.id = record.renderedId;
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-label', `Footnote ${ref.textContent?.trim() ?? ''}`.trim());
        popover.tabIndex = -1;
        const list = document.createElement('ol');
        const item = this.cloneNote(record, false);
        item.value = Math.max(1, this.records.indexOf(record) + 1);
        list.appendChild(item);
        popover.appendChild(list);
        document.body.appendChild(popover);
        this.ownedElements.push(popover);
        this.popover = popover;

        const refRect = ref.getBoundingClientRect();
        const popoverRect = popover.getBoundingClientRect();
        const ownerWindow = this.preview.ownerDocument.defaultView ?? window;
        const left = Math.max(8, Math.min(
            ownerWindow.innerWidth - popoverRect.width - 8,
            refRect.left + refRect.width / 2 - popoverRect.width / 2
        ));
        const below = refRect.bottom + 8;
        const preferredTop = below + popoverRect.height <= ownerWindow.innerHeight - 8
            ? below
            : refRect.top - popoverRect.height - 8;
        const top = Math.max(8, Math.min(
            ownerWindow.innerHeight - popoverRect.height - 8,
            preferredTop
        ));
        popover.style.left = `${left}px`;
        popover.style.top = `${top}px`;
        record.refs.forEach(anchor => anchor.setAttribute('aria-expanded', 'true'));
        popover.focus({ preventScroll: true });
    }

    private closePopover(): void {
        if (!this.popover) return;
        const popover = this.popover;
        this.popover = null;
        popover.remove();
        this.ownedElements = this.ownedElements.filter(element => element !== popover);
        this.records.flatMap(record => record.refs)
            .forEach(anchor => anchor.setAttribute('aria-expanded', 'false'));
    }

    private reset(): void {
        this.closePopover();
        this.records.forEach(record => record.refs.forEach((ref, index) => {
            ref.setAttribute('href', record.originalHrefs[index]);
            ref.removeAttribute('data-mms-sidenote-target');
            ref.removeAttribute('aria-controls');
            ref.removeAttribute('aria-expanded');
            ref.removeAttribute('aria-haspopup');
        }));
        this.sourceContainers.forEach(source => source.classList.remove('mms-footnote-source'));
        this.ownedElements.forEach(element => element.remove());
        this.records = [];
        this.sourceContainers.clear();
        this.ownedElements = [];
        this.preview.classList.remove('mms-sidenotes-wide', 'mms-sidenotes-narrow');
    }

    private hashTarget(href: string | null): string | null {
        if (!href) return null;
        const hashIndex = href.lastIndexOf('#');
        if (hashIndex < 0) return null;
        try {
            return decodeURIComponent(href.slice(hashIndex + 1));
        } catch {
            return href.slice(hashIndex + 1);
        }
    }
}
