import { App, MarkdownView, Notice, TFile } from 'obsidian';
import { normalizeAnchorText } from './position';

interface ReadingSelectionSnapshot {
    selectedText: string;
    blockText: string;
    prefixText: string;
    suffixText: string;
}

interface SourceRange {
    start: number;
    end: number;
}

interface SemanticSelection {
    range: Range;
    text: string;
    blockText: string;
    start: number;
    end: number;
}

/** Adds a small, Markdown-native action bar for selections in Reading view. */
export class ReadingSelectionController {
    private toolbar: HTMLElement | null = null;
    private snapshot: ReadingSelectionSnapshot | null = null;
    private readonly onMouseUp = () => this.ownerWindow().setTimeout(() => this.captureSelection(), 0);
    private readonly onKeyUp = (event: KeyboardEvent) => {
        if (event.shiftKey) this.ownerWindow().setTimeout(() => this.captureSelection(), 0);
    };
    private readonly onScroll = () => this.hide();
    private readonly onDocumentPointerDown = (event: PointerEvent) => {
        const target = event.target as Node | null;
        if (target && !this.toolbar?.contains(target) && !this.preview.contains(target)) this.hide();
    };

    constructor(
        private readonly app: App,
        private readonly view: MarkdownView,
        private readonly preview: HTMLElement
    ) {
        preview.addEventListener('mouseup', this.onMouseUp);
        preview.addEventListener('keyup', this.onKeyUp);
        preview.addEventListener('scroll', this.onScroll, { passive: true });
        preview.ownerDocument.addEventListener('pointerdown', this.onDocumentPointerDown, true);
    }

    destroy(): void {
        this.hide();
        this.preview.removeEventListener('mouseup', this.onMouseUp);
        this.preview.removeEventListener('keyup', this.onKeyUp);
        this.preview.removeEventListener('scroll', this.onScroll);
        this.preview.ownerDocument.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
    }

    private captureSelection(): void {
        const selection = this.ownerWindow().getSelection();
        if (!selection || selection.isCollapsed || !selection.rangeCount) {
            this.hide();
            return;
        }
        const range = selection.getRangeAt(0);
        const startElement = this.elementForNode(range.startContainer);
        const endElement = this.elementForNode(range.endContainer);
        if (!startElement || !endElement || !this.preview.contains(startElement) || !this.preview.contains(endElement)) {
            this.hide();
            return;
        }
        const startBlock = startElement.closest<HTMLElement>('p, li, blockquote, td, th');
        const endBlock = endElement.closest<HTMLElement>('p, li, blockquote, td, th');
        if (!startBlock || startBlock !== endBlock) {
            this.hide();
            return;
        }
        const semantic = this.snapToSemanticBoundaries(startBlock, range);
        if (!semantic?.text) {
            this.hide();
            return;
        }
        selection.removeAllRanges();
        selection.addRange(semantic.range);
        this.snapshot = {
            selectedText: semantic.text,
            blockText: semantic.blockText.trim(),
            prefixText: semantic.blockText.slice(Math.max(0, semantic.start - 120), semantic.start),
            suffixText: semantic.blockText.slice(semantic.end, semantic.end + 120)
        };
        this.showToolbar(semantic.range.getBoundingClientRect());
    }

    private showToolbar(selectionRect: DOMRect): void {
        this.toolbar?.remove();
        const document = this.preview.ownerDocument;
        const toolbar = document.createElement('div');
        toolbar.className = 'mms-reading-selection-toolbar';
        toolbar.dataset.mmsOwned = 'selection';
        toolbar.setAttribute('role', 'toolbar');
        toolbar.setAttribute('aria-label', 'Reading selection actions');
        toolbar.addEventListener('pointerdown', event => event.preventDefault());

        const highlight = this.actionButton('Highlight', () => void this.addHighlight());
        const addNote = this.actionButton('Add note', () => this.showNoteForm());
        toolbar.append(highlight, addNote);
        document.body.appendChild(toolbar);
        this.toolbar = toolbar;

        const width = toolbar.offsetWidth;
        const height = toolbar.offsetHeight;
        const viewportWidth = this.ownerWindow().innerWidth;
        const viewportHeight = this.ownerWindow().innerHeight;
        const left = Math.max(8, Math.min(viewportWidth - width - 8, selectionRect.left + selectionRect.width / 2 - width / 2));
        const above = selectionRect.top - height - 10;
        const top = above >= 8
            ? above
            : Math.min(viewportHeight - height - 8, selectionRect.bottom + 10);
        toolbar.style.left = `${left}px`;
        toolbar.style.top = `${Math.max(8, top)}px`;
    }

    private actionButton(label: string, action: () => void): HTMLButtonElement {
        const button = this.preview.ownerDocument.createElement('button');
        button.type = 'button';
        button.className = 'mms-reading-selection-action';
        button.textContent = label;
        button.addEventListener('click', action);
        return button;
    }

    private showNoteForm(): void {
        const toolbar = this.toolbar;
        if (!toolbar || !this.snapshot) return;
        toolbar.replaceChildren();
        toolbar.classList.add('is-note-form');
        const input = this.preview.ownerDocument.createElement('input');
        input.type = 'text';
        input.className = 'mms-reading-note-input';
        input.placeholder = 'Footnote text';
        input.setAttribute('aria-label', 'Footnote text');
        const save = this.actionButton('Save note', () => void this.addFootnote(input.value));
        const cancel = this.actionButton('Cancel', () => this.hide());
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                void this.addFootnote(input.value);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                this.hide();
            }
        });
        toolbar.append(input, save, cancel);
        input.focus();
    }

    private async addHighlight(): Promise<void> {
        const changed = await this.mutateSelection((source, range) => this.mergeHighlight(source, range));
        if (changed) new Notice('Highlight added');
    }

    private async addFootnote(noteText: string): Promise<void> {
        const note = noteText.trim().replace(/\s*\n+\s*/g, ' ');
        if (!note) {
            new Notice('Enter footnote text first');
            return;
        }
        const changed = await this.mutateSelection((source, range) => {
            const used = new Set(Array.from(source.matchAll(/\[\^([^\]]+)\]/g), match => match[1]));
            let id = 1;
            while (used.has(String(id))) id += 1;
            const reference = `[^${id}]`;
            const withReference = `${source.slice(0, range.end)}${reference}${source.slice(range.end)}`;
            const separator = withReference.endsWith('\n') ? '\n' : '\n\n';
            return `${withReference}${separator}${reference}: ${note}\n`;
        });
        if (changed) new Notice('Footnote added');
    }

    private async mutateSelection(
        transform: (source: string, range: SourceRange) => string | null
    ): Promise<boolean> {
        const snapshot = this.snapshot;
        const file = this.view.file;
        if (!snapshot || !(file instanceof TFile)) return false;
        this.hide();
        let changed = false;
        let found = false;
        await this.app.vault.process(file, source => {
            const range = this.findSourceRange(source, snapshot);
            if (!range) return source;
            found = true;
            const result = transform(source, range);
            if (result === null || result === source) return source;
            changed = true;
            return result;
        });
        if (!found) new Notice('Could not map that Reading-view selection back to Markdown');
        return changed;
    }

    private findSourceRange(source: string, snapshot: ReadingSelectionSnapshot): SourceRange | null {
        const needle = snapshot.selectedText;
        const candidates: number[] = [];
        let index = source.indexOf(needle);
        while (index >= 0) {
            candidates.push(index);
            index = source.indexOf(needle, index + Math.max(1, needle.length));
        }
        if (!candidates.length) return this.findRangeIgnoringHighlightMarkers(source, snapshot);
        if (candidates.length === 1) return { start: candidates[0], end: candidates[0] + needle.length };

        let best = candidates[0];
        let bestScore = -1;
        for (const candidate of candidates) {
            const score = this.scoreCandidate(source, candidate, needle.length, snapshot);
            if (score > bestScore) {
                best = candidate;
                bestScore = score;
            }
        }
        return { start: best, end: best + needle.length };
    }

    private snapToSemanticBoundaries(block: HTMLElement, original: Range): SemanticSelection | null {
        const blockText = (block.textContent ?? '').replace(/\u00a0/g, ' ');
        const before = original.cloneRange();
        before.selectNodeContents(block);
        before.setEnd(original.startContainer, original.startOffset);
        let start = before.toString().replace(/\u00a0/g, ' ').length;
        let end = start + original.toString().replace(/\u00a0/g, ' ').length;
        start = Math.max(0, Math.min(blockText.length, start));
        end = Math.max(start, Math.min(blockText.length, end));
        while (start < end && /\s/u.test(blockText[start])) start += 1;
        while (end > start && /\s/u.test(blockText[end - 1])) end -= 1;
        if (start === end) return null;

        while (start > 0 && this.isWordCharacter(blockText, start - 1)) start -= 1;
        while (end < blockText.length && this.isWordCharacter(blockText, end)) end += 1;

        const punctuation = /[.,;:!?…]/u;
        let punctuatedEnd = end;
        while (punctuatedEnd < blockText.length && punctuation.test(blockText[punctuatedEnd])) {
            punctuatedEnd += 1;
        }
        const pairs: Record<string, string> = {
            '"': '"', "'": "'", '“': '”', '‘': '’', '«': '»', '(': ')', '[': ']', '{': '}'
        };
        const opening = start > 0 ? blockText[start - 1] : '';
        if (opening && pairs[opening] !== undefined && pairs[opening] === blockText[punctuatedEnd]) {
            start -= 1;
            end = punctuatedEnd + 1;
            while (end < blockText.length && punctuation.test(blockText[end])) end += 1;
        } else {
            end = punctuatedEnd;
        }

        const snapped = this.rangeForTextOffsets(block, start, end);
        if (!snapped) return null;
        return { range: snapped, text: blockText.slice(start, end), blockText, start, end };
    }

    private isWordCharacter(text: string, index: number): boolean {
        const character = text[index] ?? '';
        if (/^[\p{L}\p{N}\p{M}\p{Pc}]$/u.test(character)) return true;
        if (!/[’'\-‐‑]/u.test(character)) return false;
        return index > 0
            && index + 1 < text.length
            && /^[\p{L}\p{N}\p{M}]$/u.test(text[index - 1])
            && /^[\p{L}\p{N}\p{M}]$/u.test(text[index + 1]);
    }

    private rangeForTextOffsets(block: HTMLElement, start: number, end: number): Range | null {
        const document = this.preview.ownerDocument;
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        let offset = 0;
        let startNode: Text | null = null;
        let endNode: Text | null = null;
        let startOffset = 0;
        let endOffset = 0;
        let node: Node | null;
        while ((node = walker.nextNode())) {
            const text = node as Text;
            const next = offset + text.data.length;
            if (!startNode && start <= next) {
                startNode = text;
                startOffset = Math.max(0, start - offset);
            }
            if (end <= next) {
                endNode = text;
                endOffset = Math.max(0, end - offset);
                break;
            }
            offset = next;
        }
        if (!startNode || !endNode) return null;
        const range = document.createRange();
        range.setStart(startNode, Math.min(startNode.data.length, startOffset));
        range.setEnd(endNode, Math.min(endNode.data.length, endOffset));
        return range;
    }

    private findRangeIgnoringHighlightMarkers(
        source: string,
        snapshot: ReadingSelectionSnapshot
    ): SourceRange | null {
        let plain = '';
        const sourceOffsets: number[] = [];
        for (let index = 0; index < source.length;) {
            if (source.startsWith('==', index)) {
                index += 2;
                continue;
            }
            sourceOffsets.push(index);
            plain += source[index];
            index += 1;
        }
        const candidates: number[] = [];
        let plainStart = plain.indexOf(snapshot.selectedText);
        while (plainStart >= 0) {
            candidates.push(plainStart);
            plainStart = plain.indexOf(
                snapshot.selectedText,
                plainStart + Math.max(1, snapshot.selectedText.length)
            );
        }
        if (!candidates.length) return null;

        let best = candidates[0];
        let bestScore = -1;
        for (const candidate of candidates) {
            const score = this.scoreCandidate(
                plain,
                candidate,
                snapshot.selectedText.length,
                snapshot
            );
            if (score > bestScore) {
                best = candidate;
                bestScore = score;
            }
        }

        const lastOffset = sourceOffsets[best + snapshot.selectedText.length - 1];
        if (lastOffset === undefined) return null;
        return { start: sourceOffsets[best], end: lastOffset + 1 };
    }

    private scoreCandidate(
        source: string,
        candidate: number,
        needleLength: number,
        snapshot: ReadingSelectionSnapshot
    ): number {
        const previousBreak = source.lastIndexOf('\n\n', Math.max(0, candidate - 1));
        const nextBreak = source.indexOf('\n\n', candidate + needleLength);
        const paragraphStart = previousBreak >= 0 ? previousBreak + 2 : 0;
        const paragraphEnd = nextBreak >= 0 ? nextBreak : source.length;
        const paragraph = normalizeAnchorText(source.slice(paragraphStart, paragraphEnd));
        const before = normalizeAnchorText(source.slice(
            Math.max(paragraphStart, candidate - 240),
            candidate
        ));
        const after = normalizeAnchorText(source.slice(
            candidate + needleLength,
            Math.min(paragraphEnd, candidate + needleLength + 240)
        ));
        const normalizedBlock = normalizeAnchorText(snapshot.blockText).slice(0, 100);
        const normalizedPrefix = normalizeAnchorText(snapshot.prefixText).slice(-60);
        const normalizedSuffix = normalizeAnchorText(snapshot.suffixText).slice(0, 60);

        let score = 0;
        if (normalizedBlock && paragraph.includes(normalizedBlock)) score += 8;
        if (normalizedPrefix) {
            if (before.endsWith(normalizedPrefix)) score += 4;
            else if (before.includes(normalizedPrefix)) score += 2;
        }
        if (normalizedSuffix) {
            if (after.startsWith(normalizedSuffix)) score += 4;
            else if (after.includes(normalizedSuffix)) score += 2;
        }
        return score;
    }

    private mergeHighlight(source: string, selection: SourceRange): string | null {
        if (source.slice(selection.start, selection.end).includes('\n')) {
            new Notice('Highlights must stay within one paragraph');
            return null;
        }
        const highlights: SourceRange[] = [];
        const expression = /==[^\n]*?==/g;
        let match: RegExpExecArray | null;
        while ((match = expression.exec(source))) {
            highlights.push({ start: match.index, end: match.index + match[0].length });
        }
        let start = selection.start;
        let end = selection.end;
        let expanded = true;
        while (expanded) {
            expanded = false;
            for (const highlight of highlights) {
                const gap = highlight.end < start
                    ? source.slice(highlight.end, start)
                    : end < highlight.start
                        ? source.slice(end, highlight.start)
                        : '';
                const overlaps = highlight.start <= end && highlight.end >= start;
                const joins = gap.length <= 12
                    && !gap.includes('\n')
                    && /^[\s.,;:!?…'"“”‘’()[\]{}—–\-]*$/u.test(gap);
                if (!overlaps && !joins) continue;
                const nextStart = Math.min(start, highlight.start);
                const nextEnd = Math.max(end, highlight.end);
                if (nextStart !== start || nextEnd !== end) expanded = true;
                start = nextStart;
                end = nextEnd;
            }
        }
        const inner = source.slice(start, end).replace(/==/g, '');
        const replacement = `==${inner}==`;
        if (source.slice(start, end) === replacement) return null;
        return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
    }

    private hide(): void {
        this.toolbar?.remove();
        this.toolbar = null;
        this.snapshot = null;
    }

    private elementForNode(node: Node): Element | null {
        return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
    }

    private ownerWindow(): Window {
        return this.preview.ownerDocument.defaultView ?? window;
    }
}
