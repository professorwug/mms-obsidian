import React from 'react';
import { createContext } from 'react';
import { App } from 'obsidian';

export const AppContext = createContext<App | undefined>(undefined);

export const ReactView = () => {
    return <h4>Hello, React!</h4>;
  };


import { ItemView, WorkspaceLeaf } from 'obsidian';

export const VIEW_TYPE_EXAMPLE = 'example-view';

export class ExampleView extends ItemView {
    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    getViewType() {
        return VIEW_TYPE_EXAMPLE;
    }

    getDisplayText() {
        return 'Example view';
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.createEl('h4', { text: 'Example view' });
    }

    async onClose() {
        // Nothing to clean up.
    }
}