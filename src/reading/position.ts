/** Produces a comparable plain-text key from rendered prose or Markdown. */
export function normalizeAnchorText(value: string): string {
    return value
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, '$1')
        .replace(/\[\[([^\]]+)\]\]/g, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[`*_~>#|\[\](){}]/g, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .toLocaleLowerCase()
        .replace(/\s+/g, ' ');
}

export function anchorTextsMatch(left: string, right: string): boolean {
    const a = normalizeAnchorText(left).slice(0, 120);
    const b = normalizeAnchorText(right).slice(0, 120);
    if (Math.min(a.length, b.length) < 12) return false;
    const prefixLength = Math.min(48, a.length, b.length);
    return a.slice(0, prefixLength) === b.slice(0, prefixLength)
        || (a.length >= 24 && b.includes(a.slice(0, Math.min(80, a.length))))
        || (b.length >= 24 && a.includes(b.slice(0, Math.min(80, b.length))));
}

/**
 * Resolves a semantic source anchor against rendered blocks. Exact normalized
 * matches also work for very short paragraphs; source progress breaks ties
 * between repeated blocks without coupling the renderer to Markdown line DOM.
 */
export function findBestAnchorElement<T extends Element>(
    anchorText: string,
    elements: T[],
    preferredProgress?: number
): T | null {
    const anchor = normalizeAnchorText(anchorText);
    if (!anchor || !elements.length) return null;
    const preferred = preferredProgress === undefined
        ? null
        : Math.max(0, Math.min(1, preferredProgress));
    let best: T | null = null;
    let bestScore = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    elements.forEach((element, index) => {
        const rendered = normalizeAnchorText(element.textContent ?? '');
        if (!rendered) return;
        let score = -1;
        if (rendered === anchor) score = 100;
        else if (Math.min(anchor.length, rendered.length) >= 12 && anchorTextsMatch(anchor, rendered)) {
            score = 70;
        }
        if (score < 0) return;
        const progress = elements.length > 1 ? index / (elements.length - 1) : 0;
        const distance = preferred === null ? index : Math.abs(progress - preferred);
        if (score > bestScore || (score === bestScore && distance < bestDistance)) {
            best = element;
            bestScore = score;
            bestDistance = distance;
        }
    });
    return best;
}
