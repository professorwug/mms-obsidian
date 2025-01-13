console.log('Initializing command registry interface...');
const DEBOUNCE_TIME = 1000; // 1 second
let lastObsidianOpen = 0;

// Command handlers
const commandHandlers = {
    'Move Files': async (context) => {
        console.log('\n=== Move Files Command ===');
        console.log('Raw context:', context);
        
        if (!context?.selectedNodes?.length) {
            console.error('No nodes selected for move');
            showToast('Please select files to move', true);
            return;
        }

        // Get stable IDs of selected nodes
        const sourceIds = context.selectedNodes.map(node => node.stableId);
        
        // Start move operation - this sets UI state and waits for target selection
        document.dispatchEvent(new CustomEvent('start-move-files', {
            detail: { nodeIds: sourceIds }
        }));
    },
    
    'Open in Obsidian': async (context) => {
        console.log('\n=== Open in Obsidian Command ===');
        console.log('Raw context:', context);
        
        const now = Date.now();
        if (now - lastObsidianOpen < DEBOUNCE_TIME) {
            console.log('Debouncing Obsidian open request');
            return;
        }
        lastObsidianOpen = now;

        // Validate context and selectedNodes
        if (!context?.selectedNodes?.length) {
            console.error('Invalid context:', context);
            showToast('No selection context available', true);
            return;
        }

        if (context.selectedNodes.length !== 1) {
            console.log('Invalid selection count:', context.selectedNodes.length);
            showToast('Please select a single file to open in Obsidian');
            return;
        }

        // Get the first selected node data
        const selectedNode = context.selectedNodes[0];
        console.log('Selected node:', selectedNode);

        // Get the stable ID from the serialized data
        const stableId = selectedNode.stableId;
        console.log('Stable ID:', stableId);

        if (!stableId) {
            console.error('No stable ID found in selection data');
            showToast('Cannot open file: no stable ID found', true);
            return;
        }

        console.log('Opening file with stable ID:', stableId);

        try {
            const result = await window.api.openInObsidian(stableId);
            if (result.success) {
                showToast('Opening file in Obsidian...');
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            console.error('Error opening in Obsidian:', error);
            showToast(`Failed to open in Obsidian: ${error.message}`, true);
        }
    }
};

const registry = {
    execute: async (commandName, context) => {
        console.log('Executing command:', commandName);
        
        const handler = commandHandlers[commandName];
        if (!handler) {
            console.error('No handler found for command:', commandName);
            return;
        }

        // Create serializable context
        const serializedContext = {
            selectedNodes: Array.from(context.selectedNodes || []).map(node => ({
                stableId: node.dataset.stableId,
                nodeId: node.dataset.nodeId,
                className: node.className
            }))
        };
        
        console.log('Serialized context:', serializedContext);
        return await handler(serializedContext);
    },
    getAllCommands: async () => {
        console.log('Getting all commands...');
        if (!window.commandRegistry) {
            console.error('commandRegistry not found in window object!', window);
            throw new Error('Command registry not initialized');
        }
        const commands = await window.commandRegistry.getAllCommands();
        console.log('Retrieved commands:', commands);
        return commands;
    }
};

let settings;

// Add event listener for fold-all command
document.addEventListener('fold-all-hierarchies', () => {
    // Clear expanded nodes set
    expandedNodes.clear();
    saveExpandedState();
    
    // Update UI
    const toggles = document.querySelectorAll('.toggle.expanded');
    toggles.forEach(toggle => {
        toggle.textContent = '►';
        toggle.classList.remove('expanded');
        const container = toggle.closest('.tree-item').parentElement.querySelector('div:not(.tree-item)');
        if (container) {
            container.style.display = 'none';
        }
    });
    
    updateVisibleNodes();
});

// Add event listener for tree refresh
document.addEventListener('refresh-tree', (event) => {
    currentGraph = event.detail;
    renderTree(currentGraph);
});

async function initializeSettings() {
    settings = await window.api.getSettings();
    window.api.onSettingsChanged((newSettings) => {
        settings = newSettings;
    });
}

initializeSettings().catch(console.error);

function debugCommand(commandName, context) {
    console.log('\n=== Command Execution Debug ===');
    console.log('Command:', commandName);
    console.log('Context:', {
        selectedNodes: Array.from(context.selectedNodes).map(node => ({
            id: node.dataset.nodeId,
            className: node.className
        }))
    });
}

window.api.onExecuteCommand((command) => {
    debugCommand(command, { selectedNodes });
    registry.execute(command, { selectedNodes });
});


let baseDirectory = null; // Store the base directory path

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash;
}

async function showCommandPalette() {
    const overlay = document.getElementById("commandPaletteOverlay");
    const input = document.getElementById("commandPaletteInput");
    const results = document.getElementById("commandPaletteResults");
    let selectedIndex = -1;
    let updateTimeout = null;

    overlay.style.display = "flex";
    input.value = "";
    
    // Remove any existing event listeners
    const newInput = input.cloneNode(true);
    input.parentNode.replaceChild(newInput, input);
    newInput.focus();


    function updateSelection() {
        const items = results.querySelectorAll(".quick-open-item");
        items.forEach((item) => item.classList.remove("selected"));
        if (selectedIndex >= 0 && items[selectedIndex]) {
            items[selectedIndex].classList.add("selected");
            items[selectedIndex].scrollIntoView({ block: "nearest" });
        }
    }

    // Restore keyboard navigation
    newInput.addEventListener("keydown", (event) => {
        const items = results.querySelectorAll(".quick-open-item");

        switch (event.key) {
            case "ArrowDown":
                event.preventDefault();
                selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
                updateSelection();
                break;

            case "ArrowUp":
                event.preventDefault();
                selectedIndex = Math.max(selectedIndex - 1, 0);
                updateSelection();
                break;

            case "Enter":
                if (selectedIndex >= 0) {
                    const commandName = items[selectedIndex].querySelector("span").textContent;
                    registry.execute(commandName, { selectedNodes });
                    hideCommandPalette();
                }
                break;

            case "Escape":
                hideCommandPalette();
                break;
        }
    });

    // Restore overlay click handler
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
            hideCommandPalette();
        }
    });

    async function updateResults() {
        console.log('Updating command palette results...');
        const searchTerm = newInput.value;
        results.innerHTML = ""; // Clear existing results

        try {
            console.log('Fetching commands...');
            const commands = await registry.getAllCommands();
            console.log('Received commands:', commands);
            
            // Create a Map of command names to ensure uniqueness
            const uniqueCommands = new Map();
            commands.forEach(command => {
                if (!uniqueCommands.has(command.name)) {
                    uniqueCommands.set(command.name, command);
                } else {
                    console.warn('Duplicate command found:', command.name);
                }
            });

            const filteredCommands = !searchTerm ? Array.from(uniqueCommands.values()) : 
                Array.from(uniqueCommands.values())
                    .map(command => ({
                        command,
                        score: fuzzyMatch(searchTerm, command.name)
                    }))
                    .filter(result => result.score > 0)
                    .sort((a, b) => b.score - a.score)
                    .map(result => result.command);

            console.log('Filtered unique commands:', filteredCommands);
            
            // Clear results before adding new ones
            results.innerHTML = "";
            
            filteredCommands.forEach(command => addCommandToResults(command));

            selectedIndex = filteredCommands.length > 0 ? 0 : -1;
            updateSelection();
        } catch (error) {
            console.error('Error updating command palette:', error);
            results.innerHTML = `<div class="error-message">Error loading commands: ${error.message}</div>`;
        }
    }

    function addCommandToResults(command) {
        const div = document.createElement("div");
        div.className = "quick-open-item";
        // Create a unique ID for the result item
        div.id = `command-${hashCode(command.name)}`;
    
        div.innerHTML = `
            <span>${command.name}</span>
            ${command.keybinding ? `<span style="margin-left: auto; opacity: 0.5;">${command.keybinding}</span>` : ''}
        `;

        div.addEventListener("click", () => {
            registry.execute(command.name, { selectedNodes });
            hideCommandPalette();
        });

        // Check if this command already exists in results
        const existing = document.getElementById(div.id);
        if (existing) {
            console.warn(`Duplicate command result prevented: ${command.name}`);
            return;
        }

        results.appendChild(div);
    }

    function hideCommandPalette() {
        overlay.style.display = "none";
    }

    // Debounce the input handler
    newInput.addEventListener("input", () => {
        if (updateTimeout) {
            clearTimeout(updateTimeout);
        }
        updateTimeout = setTimeout(() => {
            updateResults().catch(console.error);
        }, 100);
    });

    input.addEventListener("keydown", (event) => {
        const items = results.querySelectorAll(".quick-open-item");

        switch (event.key) {
            case "ArrowDown":
                event.preventDefault();
                selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
                updateSelection();
                break;

            case "ArrowUp":
                event.preventDefault();
                selectedIndex = Math.max(selectedIndex - 1, 0);
                updateSelection();
                break;

            case "Enter":
                if (selectedIndex >= 0) {
                    const commandName = items[selectedIndex].querySelector("span").textContent;
                    registry.execute(commandName, { selectedNodes });
                    hideCommandPalette();
                }
                break;

            case "Escape":
                hideCommandPalette();
                break;
        }
    });

    function updateSelection() {
        const items = results.querySelectorAll(".quick-open-item");
        items.forEach((item) => item.classList.remove("selected"));
        if (selectedIndex >= 0 && items[selectedIndex]) {
            items[selectedIndex].classList.add("selected");
            items[selectedIndex].scrollIntoView({ block: "nearest" });
        }
    }

    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
            hideCommandPalette();
        }
    });

    await updateResults();
}

function generateColorFromHash(hash) {
  // Generate a subtle beige variation
  const hue = 40 + (Math.abs(hash) % 20); // Keep in beige range (30-60)
  const saturation = 20 + (Math.abs(hash) % 15); // Subtle saturation
  const lightness = 85 - (Math.abs(hash) % 10); // Keep it light
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

// Debug function for key events
function debugKeyEvent(event) {
    console.log('\n=== Key Event Debug ===');
    console.log('Key:', event.key);
    console.log('Ctrl:', event.ctrlKey);
    console.log('Cmd/Meta:', event.metaKey);
    console.log('Moving nodes:', movingNodes);
    console.log('Last selected node:', lastSelectedNode?.dataset?.nodeId);
}


let currentGraph = null;
let selectedNodes = new Set();
let lastSelectedNode = null;
let visibleNodes = []; // Will store currently visible nodes in display order
let nodeIdToElement = new Map(); // Maps node IDs to their DOM elements
let expandedNodes = new Set();
let treeKeydownListener = null;
let treeContainer = null;
let isListenerActive = false; // Add this flag to track listener state
let movingNodes = null;
let moveOperationInProgress = false;

// Add the event listener for starting move operation
document.addEventListener('start-move-files', (event) => {
    console.log('\n=== Starting Move Operation ===');
    
    if (moveOperationInProgress) {
        console.log('Move operation already in progress, ignoring');
        return;
    }

    if (!event.detail?.nodeIds?.length) {
        console.log('No node IDs provided for move');
        return;
    }

    // Validate all nodes exist in current graph
    const invalidNodes = event.detail.nodeIds.filter(id => !currentGraph?.nodes?.[id]);
    if (invalidNodes.length > 0) {
        console.error('Invalid nodes in move operation:', invalidNodes);
        showToast('Cannot move: some nodes are invalid', true);
        return;
    }

    moveOperationInProgress = true;
    movingNodes = event.detail.nodeIds;
    
    console.log('Move operation started:', {
        nodes: movingNodes,
        graphState: {
            nodeCount: Object.keys(currentGraph?.nodes || {}).length,
            validNodes: movingNodes.every(id => currentGraph?.nodes?.[id])
        }
    });

    // Find parent of first moving node using graph edges
    const firstNodeId = movingNodes[0];
    const parentId = Object.keys(currentGraph.edges).find(id => 
        currentGraph.edges[id] && currentGraph.edges[id].includes(firstNodeId)
    );
    console.log('Parent node to select:', parentId);
    
    // Clear current selection
    selectedNodes.forEach(node => {
        node.classList.remove('selected');
    });
    selectedNodes.clear();
    
    // Mark nodes being moved
    movingNodes.forEach(nodeId => {
        const element = nodeIdToElement.get(nodeId);
        if (element) {
            element.style.opacity = '0.5';
            element.classList.add('being-moved');
        }
    });
    
    // Select the parent node if found
    if (parentId) {
        const parentElement = nodeIdToElement.get(parentId);
        if (parentElement) {
            selectNode(parentElement);
            treeContainer.focus();
        }
    }
    
    showToast('Navigate to destination and press Ctrl+V (Cmd+V on Mac) to complete move');
});

// Save expanded state
function saveExpandedState() {
  const expanded = Array.from(expandedNodes);
  localStorage.setItem("expandedNodes", JSON.stringify(expanded));
}

// Load expanded state
function loadExpandedState() {
  try {
    const saved = localStorage.getItem("expandedNodes");
    if (saved) {
      expandedNodes = new Set(JSON.parse(saved));
    }
  } catch (e) {
    console.error("Error loading expanded state:", e);
    expandedNodes = new Set();
  }
}

function selectNode(element, multiSelect = false) {
    console.log('\n=== Selecting Node ===');
    console.log('Element:', element);
    console.log('Multi-select:', multiSelect);

    if (!multiSelect) {
        // Clear previous selections
        console.log('Clearing previous selections');
        selectedNodes.forEach((node) => {
            node.classList.remove("selected");
        });
        selectedNodes.clear();
    }

    console.log('Adding node to selection:', {
        stableId: element.dataset.stableId,
        className: element.className
    });

    element.classList.add("selected");
    selectedNodes.add(element);
    lastSelectedNode = element;
    element.scrollIntoView({ block: "nearest", behavior: "smooth" });

    console.log('Current selection:', {
        size: selectedNodes.size,
        nodes: Array.from(selectedNodes).map(node => ({
            stableId: node.dataset.stableId,
            className: node.className
        }))
    });
}

function updateVisibleNodes() {
  visibleNodes = Array.from(document.querySelectorAll(".tree-item")).filter(
    (node) => {
      const style = window.getComputedStyle(node);
      return style.display !== "none" && node.offsetParent !== null;
    },
  );
}

function handleKeyNavigation(event) {
  debugKeyEvent(event);

  // Check for Ctrl+V/Cmd+V to complete move
  // if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
  //     console.log('Move completion shortcut detected!');
  //     if (movingNodes && lastSelectedNode) {
  //         console.log('Attempting to complete move operation');
  //         event.preventDefault(); // Prevent default paste behavior
  //         event.stopPropagation(); // Stop event from bubbling
  //         console.log('Last selected node:', lastSelectedNode);
  //         completeMoveOperation(lastSelectedNode.dataset.stableId);
  //         return;
  //     } else {
  //         console.log('Move completion conditions not met:', {
  //             movingNodes: Boolean(movingNodes),
  //             lastSelectedNode: Boolean(lastSelectedNode)
  //         });
  //     }
  // }
  
  if (event.key === 'Enter') {
      if (settings?.nodeActions?.['enter-action']) {
          const enterAction = settings.nodeActions['enter-action'];
          if (enterAction && selectedNodes.size > 0) {
              event.preventDefault();
              registry.execute(enterAction, { selectedNodes });
              return;
          }
      }
  }
  
  const keys = [];
  if (event.metaKey) keys.push('Cmd');
  if (event.ctrlKey) keys.push('Ctrl');
  if (event.altKey) keys.push('Alt');
  if (event.shiftKey) keys.push('Shift');
  if (event.key !== 'Meta' && event.key !== 'Control' && event.key !== 'Alt' && event.key !== 'Shift') {
      keys.push(event.key.toUpperCase());
  }
  
  const pressedShortcut = keys.join('+');
  
  // Check custom shortcuts
  for (const [command, shortcut] of Object.entries(settings.shortcuts)) {
      if (shortcut === pressedShortcut) {
          event.preventDefault();
          registry.execute(command, { selectedNodes });
          return;
      }
  }
  
  // Ignore keyboard navigation if we're in an input field
  if (event.target.tagName.toLowerCase() === "input") {
    return;
  }

  if (!lastSelectedNode) return;

  updateVisibleNodes();
  const currentIndex = visibleNodes.indexOf(lastSelectedNode);
  let nextIndex = currentIndex;
  let handled = true;

  switch (event.key.toLowerCase()) {
    case "j":
    case "J":
        if (!event.ctrlKey && !event.metaKey) { // Only handle 'j' if not part of a command shortcut
            nextIndex = Math.min(currentIndex + 1, visibleNodes.length - 1);
            break;
        }
        handled = false;
        break; // Changed from return to break
    case "arrowdown":
        nextIndex = Math.min(currentIndex + 1, visibleNodes.length - 1);
        break;
    case "k":
    case "K":
        if (!event.ctrlKey && !event.metaKey) { // Only handle 'k' if not part of a command shortcut
            nextIndex = Math.max(currentIndex - 1, 0);
            break;
        }
        handled = false;
        break; // Changed from return to break
    case "arrowup":
        nextIndex = Math.max(currentIndex - 1, 0);
        break;
    case "h":
    case "arrowleft": {
      const currentStableId = lastSelectedNode.dataset.stableId;
      if (currentStableId) {
        // Find parent from graph edges
        const edges = currentGraph.edges || {};
        const parentStableId = Object.keys(edges).find(id => 
            edges[id] && edges[id].includes(currentStableId)
        );
        
        if (parentStableId) {
            const parentElement = nodeIdToElement.get(parentStableId);
            if (parentElement) {
                // First select the parent
                selectNode(parentElement, event.shiftKey);
                
                // Then collapse the children container of the parent
                const childrenContainer = parentElement.parentElement.querySelector(":scope > div:not(.tree-item)");
                const toggle = parentElement.querySelector(".toggle");
                
                if (childrenContainer && toggle) {
                    childrenContainer.style.display = "none";
                    toggle.textContent = "►";
                    toggle.classList.remove("expanded");
                    expandedNodes.delete(parentStableId);
                    saveExpandedState();
                }
                
                updateVisibleNodes();
            }
        }
      }
      break;
    }
    case "l":
    case "arrowright": {
      const toggle = lastSelectedNode.querySelector(".toggle");
      if (toggle && !toggle.classList.contains("expanded")) {
        // Expand the node
        const childrenContainer = lastSelectedNode.parentElement.querySelector(":scope > div:not(.tree-item)");
        if (childrenContainer) {
            childrenContainer.style.display = "block";
            toggle.textContent = "▼";
            toggle.classList.add("expanded");
            expandedNodes.add(lastSelectedNode.dataset.nodeId);
            saveExpandedState();
            
            // Find and select the first child
            const firstChildElement = childrenContainer.querySelector(".tree-item");
            if (firstChildElement) {
                selectNode(firstChildElement, event.shiftKey);
            }
            
            updateVisibleNodes();
        }
      }
      break;
    }
    default:
      handled = false;
  }

  if (handled) {
    event.preventDefault();
    if (nextIndex !== currentIndex) {
      selectNode(visibleNodes[nextIndex], event.shiftKey);
    }
  }
}

let isRenaming = false;

async function handleRename() {
  if (isRenaming) {
    console.log("Rename already in progress, ignoring");
    return;
  }

  if (selectedNodes.size !== 1 || !lastSelectedNode) {
    console.log("Cannot rename: multiple or no nodes selected");
    return;
  }

  try {
    isRenaming = true;
    console.log("Starting rename for node:", lastSelectedNode.dataset.nodeId);
    const textSpan = lastSelectedNode.querySelector("span:not(.toggle)");
    const nodeId = lastSelectedNode.dataset.nodeId;
    const nodeData = currentGraph.nodes[nodeId];

    // Early exit if not renameable
    if (!nodeData && !lastSelectedNode.classList.contains("surrogate-node")) {
      console.error("No node data found for:", nodeId);
      return;
    }

    const input = document.createElement("input");
    input.type = "text";
    
    // Get just the name without the ID prefix and extension
    const currentName = nodeData.name || "";
    const extension = nodeData.extension || "";
    input.value = currentName.replace(extension, "");
    
    input.style.width = "90%";
    input.style.background = "var(--bg-secondary)";
    input.style.color = "var(--text-primary)";
    input.style.border = "1px solid var(--text-secondary)";
    input.style.padding = "2px 4px";

    textSpan.style.display = "none";
    lastSelectedNode.appendChild(input);
    input.focus();
    input.setSelectionRange(0, input.value.length);

    const cleanup = () => {
      isRenaming = false;
      if (input && input.parentNode) {
        input.remove();
      }
      if (textSpan) {
        textSpan.style.display = "";
      }
    };

    input.addEventListener("blur", () => {
      finishRename(input, textSpan, nodeId).finally(cleanup);
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finishRename(input, textSpan, nodeId).finally(cleanup);
      } else if (event.key === "Escape") {
        event.preventDefault();
        cleanup();
      }
    });
  } catch (error) {
    console.error("Error in handleRename:", error);
    isRenaming = false;
  }
}

async function finishRename(input, textSpan, nodeId) {
    console.log("\n=== Finishing Rename Operation ===");
    const nodeData = currentGraph.nodes[nodeId];
    const newNameWithoutExt = input.value.trim();
    const isSurrogate = lastSelectedNode.classList.contains('surrogate-node');
    const extension = isSurrogate ? '.md' : (nodeData.extension || '');
    
    console.log("Node data for rename:", {
        nodeId,
        nodeData,
        newNameWithoutExt,
        isSurrogate,
        extension,
        baseDirectory
    });

    // Early exit if no changes
    if (!newNameWithoutExt || (!isSurrogate && newNameWithoutExt === nodeData.name)) {
        console.log("Canceling rename: No change in name or empty input");
        input.remove();
        textSpan.style.display = '';
        return;
    }

    try {
        if (isSurrogate) {
            console.log("Processing surrogate node rename");
            
            // Get children using the graph edges
            const children = currentGraph.edges[nodeId] || [];
            console.log("Found children from graph edges:", children);

            // Get paths of all children
            const childPaths = children
                .map(childId => currentGraph.nodes[childId])
                .filter(childData => childData && childData.path)
                .map(childData => childData.path);

            console.log("Child paths:", childPaths);

            // Determine target directory
            let targetDir = baseDirectory;
            
            if (childPaths.length > 0) {
                // Find common path prefix
                let commonPath = childPaths[0];
                for (let path of childPaths) {
                    while (!path.startsWith(commonPath)) {
                        commonPath = commonPath.substring(0, commonPath.lastIndexOf('/'));
                        if (!commonPath) {
                            commonPath = ''; // Reset to root if no common path found
                            break;
                        }
                    }
                }
                
                console.log("Common path determined:", commonPath);
                
                if (commonPath) {
                    targetDir = window.path.join(baseDirectory, commonPath);
                }
            } else {
                console.log("No child paths found, using base directory");
            }

            console.log("Target directory determined:", targetDir);

            const fullNewName = `${nodeId} ${newNameWithoutExt}${extension}`;
            const newFullPath = window.path.join(targetDir, fullNewName);

            console.log("Creating new markdown file:", {
                children,
                childPaths,
                targetDir,
                fullNewName,
                newFullPath
            });

            const result = await window.api.createFile(newFullPath);
            console.log("Create file result:", result);

            if (!result.success) {
                throw new Error(result.error || 'Failed to create file');
            }
        } else {
            console.log("Processing regular node rename");
            const currentDir = nodeData.path 
                ? window.path.join(baseDirectory, nodeData.path)
                : baseDirectory;
            const currentFileName = `${nodeId} ${nodeData.name}${extension}`;
            const oldFullPath = window.path.join(currentDir, currentFileName);
            const fullNewName = `${nodeId} ${newNameWithoutExt}${extension}`;
            const newFullPath = window.path.join(currentDir, fullNewName);

            console.log("Renaming file:", {
                currentDir,
                currentFileName,
                oldFullPath,
                fullNewName,
                newFullPath
            });

            const result = await window.api.renameFile(oldFullPath, newFullPath);
            console.log("Rename result:", result);

            if (!result.success) {
                throw new Error(result.error || 'Failed to rename file');
            }
        }

        // Reload the directory after successful rename/create
        const reloadResult = await window.api.loadDirectory(baseDirectory);
        if (!reloadResult || !reloadResult.data) {
            throw new Error('Failed to reload directory after rename');
        }

        currentGraph = reloadResult.data;
        renderTree(currentGraph);
        
        // Find and select the renamed node
        const renamedElement = nodeIdToElement.get(nodeId);
        if (renamedElement) {
            selectNode(renamedElement);
            treeContainer.focus();
        }

    } catch (error) {
        console.error("Error during rename operation:", error);
        alert(`Error during rename: ${error.message}`);
    } finally {
        if (input && input.parentNode) {
            input.remove();
        }
        if (textSpan) {
            textSpan.style.display = '';
        }
    }
}

window.api.onDirectorySelected(async (selectedPath) => {
  try {
    console.log("\n=== Directory Selection Debug ===");
    
    // Clean up old listener
    if (treeContainer && treeKeydownListener && isListenerActive) {
      console.log("Cleaning up old keydown listener before loading new directory");
      treeContainer.removeEventListener('keydown', treeKeydownListener);
      treeKeydownListener = null;
      isListenerActive = false;
    }

    console.log("Selected path:", selectedPath);
    baseDirectory = selectedPath;
    const result = await window.api.loadDirectory(selectedPath);
    console.log("Graph data received:", result);

    if (result && result.success && result.data) {
      // Now result.data contains both graphs
      currentGraph = result.data;
      renderTree(currentGraph);
    } else {
      console.error("Invalid graph data:", result);
    }
  } catch (error) {
    console.error("Error loading directory:", error);
  }
});

function getChildNodes(parentId, graphData) {
  if (!graphData || !graphData.nodes) {
    console.warn("Invalid graph data in getChildNodes:", graphData);
    return [];
  }

  const allNodeIds = Object.keys(graphData.nodes);

  if (!parentId) {
    return allNodeIds.filter((nodeId) => nodeId.length === 2).sort();
  }

  const children = allNodeIds.filter((nodeId) => {
    if (parentId.length === 2) {
      return (
        nodeId.length === 3 &&
        nodeId.startsWith(parentId) &&
        nodeId[2].match(/[a-z]/i)
      );
    }

    if (parentId.length === 3) {
      return (
        nodeId.length === 5 &&
        nodeId.startsWith(parentId) &&
        nodeId.slice(3).match(/\d{2}/)
      );
    }

    return (
      nodeId.length === parentId.length + 2 &&
      nodeId.startsWith(parentId) &&
      nodeId.slice(-2).match(/\d{2}/)
    );
  });

  const sortedChildren = children.sort((a, b) => a.localeCompare(b));

  // Only log for root nodes
  if (parentId.length === 2) {
    console.log(`Root node ${parentId}: ${children.length} children`);
  }

  return sortedChildren;
}

function renderTree(graphData) {
    console.log("\n=== Tree Rendering Debug ===");
    console.log("Raw graph data:", JSON.stringify(graphData, null, 2));

    // Handle both direct data and wrapped data formats
    const data = graphData.data || graphData;
    
    // Detailed property validation
    console.log("\nValidating required properties:");
    console.log("- nodes:", Boolean(data.nodes), 
        data.nodes ? `(${Object.keys(data.nodes).length} entries)` : '');
    console.log("- edges:", Boolean(data.edges), 
        data.edges ? `(${Object.keys(data.edges).length} entries)` : '');
    console.log("- id_nodes:", Boolean(data.id_nodes), 
        data.id_nodes ? `(${data.id_nodes.length} entries)` : '');
    console.log("- folder_nodes:", Boolean(data.folder_nodes), 
        data.folder_nodes ? `(${data.folder_nodes.length} entries)` : '');

    if (!data.nodes || !data.edges || !data.id_nodes || !data.folder_nodes) {
        console.error("Missing required properties. Data structure:", {
            hasNodes: Boolean(data.nodes),
            nodesType: data.nodes ? typeof data.nodes : 'undefined',
            hasEdges: Boolean(data.edges),
            edgesType: data.edges ? typeof data.edges : 'undefined',
            hasIdNodes: Boolean(data.id_nodes),
            idNodesType: data.id_nodes ? typeof data.id_nodes : 'undefined',
            hasFolderNodes: Boolean(data.folder_nodes),
            folderNodesType: data.folder_nodes ? typeof data.folder_nodes : 'undefined'
        });
        return;
    }

    loadExpandedState();
    
    treeContainer = document.getElementById("directoryTree");
    treeContainer.innerHTML = "";
    treeContainer.tabIndex = 0;
    nodeIdToElement.clear();

    // Clean up old listener if it exists
    if (treeKeydownListener && isListenerActive) {
        treeContainer.removeEventListener('keydown', treeKeydownListener);
        treeKeydownListener = null;
        isListenerActive = false;
    }

    // Find root nodes (nodes with no parents or only root folder as parent)
    const allNodes = new Set(Object.keys(data.nodes));
    const childNodes = new Set();
    Object.entries(data.edges).forEach(([parent, children]) => {
        // Skip the root folder's edges when determining child status
        if (parent !== '') {
            children.forEach(child => childNodes.add(child));
        }
    });
    
    const rootNodes = Array.from(allNodes)
        .filter(nodeId => !childNodes.has(nodeId))
        .sort();

    console.log("Root nodes found:", rootNodes);

    // Render each root node and its subtree
    rootNodes.forEach(nodeId => {
        const element = createTreeNode(nodeId, data, 0);  // Start at depth 0
        treeContainer.appendChild(element);
    });

  // Create new listener with detailed logging
  treeKeydownListener = function(event) {
    console.log("\n=== Keydown Event Debug ===");
    console.log("Key pressed:", event.key);
    console.log("Target element:", event.target.tagName);
    console.log("Active element:", document.activeElement.tagName);
    console.log("Tree container focused:", document.activeElement === treeContainer);
    
    // Add command palette shortcut check first
    if (event.key === "p" && (event.metaKey || event.ctrlKey)) {
      console.log("Command palette shortcut triggered");
      event.preventDefault();
      showCommandPalette().catch(console.error);
      return;
    }

    // Ignore if we're in an input field
    if (event.target.tagName.toLowerCase() === "input") {
      console.log("Ignoring key event in input field");
      return;
    }

    // Add Enter key handling here
    if (event.key === "Enter") {
      console.log("Enter key pressed, checking for configured action");
      const enterAction = settings?.nodeActions?.['enter-action'];
      if (enterAction && selectedNodes.size > 0) {
        console.log("Executing enter action:", enterAction);
        event.preventDefault();
        registry.execute(enterAction, { selectedNodes });
        return;
      }
    }

    if (event.key === "o" && ((event.metaKey && event.shiftKey) || (event.ctrlKey && event.shiftKey))) {
      console.log("Quick open shortcut triggered");
      event.preventDefault();
      showQuickOpen();
    } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "j", "k", "h", "l", "J", "K", "H", "L"].includes(event.key)) {
      console.log("Navigation shortcut triggered");
      event.preventDefault();
      handleKeyNavigation(event);
    } else if (event.key === "r") {
      console.log("Rename shortcut triggered");
      event.preventDefault();
      handleRename();
    }
  };

  updateVisibleNodes();

  // Add the listener to the tree container
  console.log("Adding new keydown listener to tree container");
  treeContainer.addEventListener('keydown', treeKeydownListener);
  isListenerActive = true;

  // Ensure focus is set correctly 
  console.log("Setting initial focus to tree container");
  treeContainer.focus();

  const firstNode = treeContainer.querySelector(".tree-item");
  if (firstNode) {
    selectNode(firstNode);
    treeContainer.focus();
  }
}

function showToast(message, isError = false) {
    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.style.borderColor = isError ? 'var(--accent-red)' : 'var(--accent-gold)';
    
    const icon = document.createElement('span');
    icon.textContent = isError ? '⚠️' : '📝';
    toast.appendChild(icon);
    
    const text = document.createElement('span');
    text.textContent = message;
    toast.appendChild(text);
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease-in forwards';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

const style = document.createElement('style');
style.textContent = `
.quick-open-results {
    overflow-y: auto;
    max-height: 60vh;
    scroll-behavior: smooth;
}
.non-id-node {
    color: var(--text-secondary);
}

.non-id-node:hover {
    background-color: var(--bg-tertiary);
}

.non-id-node.selected {
    background-color: var(--bg-selected);
    color: var(--text-primary);
}

.node-id {
    opacity: 0.7;
    margin-right: 4px;
}

.non-id-node .node-name {
    font-style: italic;
}

.folder-icon {
    opacity: 0.7;
    margin-right: 4px;
}

.modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
}

.modal-content {
    background: var(--bg-primary);
    padding: 20px;
    border-radius: 8px;
    min-width: 300px;
}

.modal-content h2 {
    margin-top: 0;
    color: var(--text-primary);
}

.modal-content input {
    width: 100%;
    padding: 8px;
    margin: 10px 0;
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--text-secondary);
}

.modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 20px;
}

.modal-footer button {
    padding: 8px 16px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    background: var(--bg-secondary);
    color: var(--text-primary);
}

.modal-footer button:hover {
    background: var(--bg-tertiary);
}
`;
document.head.appendChild(style);

function fuzzyMatch(pattern, str) {
  pattern = pattern.toLowerCase();
  str = str.toLowerCase();

  if (pattern.length === 0) return 1;
  if (pattern.length > str.length) return 0;

  let patternIdx = 0;
  let strIdx = 0;
  let consecutiveMatches = 0;
  let totalMatches = 0;

  while (patternIdx < pattern.length && strIdx < str.length) {
    if (pattern[patternIdx] === str[strIdx]) {
      if (patternIdx > 0 && pattern[patternIdx - 1] === str[strIdx - 1]) {
        consecutiveMatches++;
      }
      totalMatches++;
      patternIdx++;
    }
    strIdx++;
  }

  if (patternIdx !== pattern.length) return 0;

  const matchRatio = totalMatches / str.length;
  const consecutiveBonus = consecutiveMatches / (pattern.length - 1 || 1);
  const positionBonus = 1 - (strIdx - totalMatches) / str.length;

  const score = matchRatio * 0.4 + consecutiveBonus * 0.4 + positionBonus * 0.2;

  return Math.min(Math.max(score, 0), 1);
}

function findNaturalBreaks(scores, k = 3) {
  if (scores.length === 0) return [];
  if (scores.length === 1) return [scores[0]];

  scores = [...scores].sort((a, b) => b - a);

  const differences = [];
  for (let i = 0; i < scores.length - 1; i++) {
    differences.push({
      index: i + 1,
      diff: scores[i] - scores[i + 1],
    });
  }

  differences.sort((a, b) => b.diff - a.diff);

  const breakPoints = differences
    .slice(0, k - 1)
    .sort((a, b) => a.index - b.index)
    .map((point) => scores[point.index]);

  return [1, ...breakPoints, 0];
}

function getScoreGroup(score, breaks) {
  for (let i = 0; i < breaks.length - 1; i++) {
    if (score <= breaks[i] && score > breaks[i + 1]) {
      return i;
    }
  }
  return breaks.length - 1;
}

async function completeMoveOperation(targetStableId) {
    if (!moveOperationInProgress || !movingNodes?.length) {
        console.log('No valid move operation in progress');
        return;
    }

    try {
        // Clear state immediately to prevent concurrent operations
        const nodesToMove = [...movingNodes];
        movingNodes = null;
        moveOperationInProgress = false;

        console.log('Executing move operation:', {
            sourceIds: nodesToMove,
            targetId: targetStableId
        });

        // Use the MoveCommand instance to perform the move
        const result = await window.api.executeMoveOperation(nodesToMove, targetStableId);
        
        console.log('Move operation result:', result);

        // Check if result has updatedFiles array (success indicator)
        if (result.updatedFiles) {
            // Clear moving state for all nodes
            document.querySelectorAll('.being-moved').forEach(el => {
                el.style.opacity = '';
                el.classList.remove('being-moved');
            });
            
            // Refresh the graph and UI
            const baseDirectory = await window.api.getBaseDirectory();
            const reloadResult = await window.api.loadDirectory(baseDirectory);
            
            if (!reloadResult.success) {
                throw new Error('Failed to reload directory after move');
            }

            currentGraph = reloadResult.data;
            renderTree(currentGraph);
            
            showToast('Files moved successfully');
        } else {
            throw new Error(result.error || 'Move operation failed');
        }
    } catch (error) {
        console.error('Move Operation Error:', error);
        
        // Reset UI state
        document.querySelectorAll('.being-moved').forEach(el => {
            el.style.opacity = '';
            el.classList.remove('being-moved');
        });
        
        showToast(`Move failed: ${error.message}`, true);
    } finally {
        // Ensure state is cleared even if error occurs
        moveOperationInProgress = false;
        movingNodes = null;
    }
}

// Add global event listener for paste shortcut
document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
        console.log('Paste Handler State:', {
            moveInProgress: moveOperationInProgress,
            hasMovingNodes: !!movingNodes?.length,
            targetNode: lastSelectedNode?.dataset?.stableId,
            targetExists: lastSelectedNode ? !!currentGraph?.nodes?.[lastSelectedNode.dataset.stableId] : false
        });
        
        if (moveOperationInProgress && movingNodes?.length && lastSelectedNode) {
            console.log('Completing move from global handler');
            event.preventDefault();
            event.stopPropagation();
            console.log('Last selected node:', lastSelectedNode);
            completeMoveOperation(lastSelectedNode.dataset.stableId);
        }
    }
});

function findParentNodes(nodeId, edges) {
    const parents = [];
    for (const [parent, children] of Object.entries(edges)) {
        if (children.includes(nodeId)) {
            parents.push(parent);
            // Recursively find parents of this parent
            parents.push(...findParentNodes(parent, edges));
        }
    }
    return parents;
}

function expandNodeElement(element) {
    const parentContainer = element.parentElement;
    const childrenContainer = parentContainer.querySelector(":scope > div:not(.tree-item)");
    
    if (childrenContainer && window.getComputedStyle(childrenContainer).display === "none") {
        console.log(`Expanding children container for ${element.dataset.stableId}`);
        childrenContainer.style.display = "block";

        const toggle = element.querySelector(".toggle");
        if (toggle) {
            toggle.textContent = "▼";
            toggle.classList.add("expanded");
            expandedNodes.add(element.dataset.stableId);
            console.log(`Updated toggle and added ${element.dataset.stableId} to expandedNodes`);
        }
    }
}

function showQuickOpen() {
  const overlay = document.getElementById("quickOpenOverlay");
  const input = document.getElementById("quickOpenInput");
  const results = document.getElementById("quickOpenResults");
  let selectedIndex = -1;

  overlay.style.display = "flex";
  input.value = "";
  input.focus();

  function updateResults() {
    const searchTerm = input.value;
    results.innerHTML = "";
    
    if (!searchTerm) {
        return;
    }

    console.log("Searching through nodes:", currentGraph.nodes);

    // Get and sort all matching nodes first
    const matchedNodes = Object.keys(currentGraph.nodes)
        .map((nodeId) => {
            const nodeData = currentGraph.nodes[nodeId];
            const name = nodeData.name || nodeId;
            const displayName = `${nodeId} ${name}`;
            const score = fuzzyMatch(searchTerm, displayName);
            return {
                id: nodeId,
                name,
                fullPath: nodeData.path || "",
                score,
                extension: nodeData.extension || "",
            };
        })
        .filter((node) => node.score > 0);

    console.log(`Found ${matchedNodes.length} matching nodes`);

    const scores = matchedNodes.map((node) => node.score);
    const breaks = findNaturalBreaks(scores);

    const sortedNodes = matchedNodes
        .map((node) => ({
            ...node,
            group: getScoreGroup(node.score, breaks),
        }))
        .sort((a, b) => {
            if (a.group !== b.group) {
                return a.group - b.group;
            }
            return a.id.length - b.id.length;
        });

    // Create container for virtual scrolling
    const virtualContainer = document.createElement('div');
    virtualContainer.style.height = `${sortedNodes.length * 30}px`; // Estimate height (30px per item)
    virtualContainer.style.position = 'relative';
    results.appendChild(virtualContainer);

    const renderWindow = document.createElement('div');
    renderWindow.style.position = 'absolute';
    renderWindow.style.width = '100%';
    renderWindow.style.top = '0';
    virtualContainer.appendChild(renderWindow);

    let lastGroup = -1;
    let lastRenderedStart = 0;
    let lastRenderedEnd = 0;
    const RENDER_BUFFER = 20; // Number of extra items to render above/below viewport
    const ITEM_HEIGHT = 30; // Height of each item in pixels

    function renderItems(startIndex, endIndex) {
        // Don't re-render if the range hasn't changed
        if (startIndex === lastRenderedStart && endIndex === lastRenderedEnd) {
            return;
        }

        console.log(`Rendering items ${startIndex} to ${endIndex} of ${sortedNodes.length}`);
        renderWindow.innerHTML = '';
        renderWindow.style.top = `${startIndex * ITEM_HEIGHT}px`;

        let currentGroup = lastGroup;
        
        for (let i = startIndex; i < Math.min(endIndex, sortedNodes.length); i++) {
            const node = sortedNodes[i];
            
            if (node.group !== currentGroup) {
                const separator = document.createElement("div");
                separator.className = "quick-open-group";
                separator.style.padding = "4px 12px";
                separator.style.fontSize = "0.8em";
                separator.style.color = "var(--text-secondary)";
                separator.style.borderTop = "1px solid var(--bg-tertiary)";
                separator.textContent = `Match Group ${node.group + 1}`;
                renderWindow.appendChild(separator);
                currentGroup = node.group;
            }

            const div = document.createElement("div");
            div.className = "quick-open-item";
            div.style.height = `${ITEM_HEIGHT}px`;
            div.innerHTML = `
                <span class="quick-open-id">${currentGraph.nodes[node.id].id || ''}</span>
                <span>${node.name}</span>
                <span style="margin-left: auto; opacity: 0.5; font-size: 0.8em;">
                    ${Math.round(node.score * 100)}%
                </span>
            `;

            div.addEventListener("click", () => {
                navigateToNode(node.id);
                hideQuickOpen();
            });

            renderWindow.appendChild(div);
        }

        lastRenderedStart = startIndex;
        lastRenderedEnd = endIndex;
        lastGroup = currentGroup;
    }

    function updateVisibleItems() {
        const scrollTop = results.scrollTop;
        const viewportHeight = results.clientHeight;
        
        // Calculate which items should be visible
        let startIndex = Math.floor(scrollTop / ITEM_HEIGHT) - RENDER_BUFFER;
        startIndex = Math.max(0, startIndex);
        
        let endIndex = Math.ceil((scrollTop + viewportHeight) / ITEM_HEIGHT) + RENDER_BUFFER;
        endIndex = Math.min(sortedNodes.length, endIndex);
        
        renderItems(startIndex, endIndex);
    }

    // Initial render
    renderItems(0, 50);

    // Update on scroll
    results.addEventListener('scroll', () => {
        requestAnimationFrame(updateVisibleItems);
    });

    selectedIndex = sortedNodes.length > 0 ? 0 : -1;
    updateSelection();
  }

  function updateSelection() {
    const items = results.querySelectorAll(".quick-open-item");
    items.forEach((item) => item.classList.remove("selected"));
    if (selectedIndex >= 0 && items[selectedIndex]) {
      items[selectedIndex].classList.add("selected");
      items[selectedIndex].scrollIntoView({ block: "nearest" });
    }
  }

  function navigateToNode(nodeId) {
    console.log(`=== Navigating to node: ${nodeId} ===`);
    
    // First verify this is a valid node in our graph
    if (!currentGraph.nodes[nodeId]) {
        console.warn(`Invalid nodeId (not in graph): ${nodeId}`);
        return;
    }

    const element = nodeIdToElement.get(nodeId);
    if (!element) {
        console.warn(`Element not found for nodeId: ${nodeId}`);
        return;
    }

    // Check if this is a folder node using the folder_nodes set
    const isFolderNode = currentGraph.folder_nodes.includes(nodeId);
    console.log(`Node type: ${isFolderNode ? 'folder' : 'file'}, nodeId: ${nodeId}`);
    
    if (isFolderNode) {
        // For folders, split the path and expand each parent level
        const pathParts = nodeId.split('/').filter(Boolean);
        let currentPath = '';
        
        pathParts.forEach(part => {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            console.log(`Checking parent path: ${currentPath}`);
            
            const parentElement = nodeIdToElement.get(currentPath);
            if (parentElement) {
                expandNodeElement(parentElement);
            }
        });
    } else {
        // For files, use the Folgezettel ID parent chain
        const nodeData = currentGraph.nodes[nodeId];
        if (nodeData && nodeData.id) {
            const parentIds = [];
            let currentId = nodeData.id;
            
            while (currentId.length > 2) {
                if (currentId.length > 3 && /\d{2}$/.test(currentId)) {
                    currentId = currentId.slice(0, -2);
                } else if (currentId.length === 3) {
                    currentId = currentId.slice(0, -1);
                }
                parentIds.unshift(currentId);
                console.log(`Added parent ID: ${currentId}`);
            }
            
            // Process parent chain
            parentIds.forEach((parentId) => {
                const stableId = Object.keys(currentGraph.nodes).find(id => 
                    currentGraph.nodes[id].id === parentId
                );
                
                if (stableId) {
                    console.log(`Processing parent: ${stableId} (Folgezettel ID: ${parentId})`);
                    const parentElement = nodeIdToElement.get(stableId);
                    if (parentElement) {
                        expandNodeElement(parentElement);
                    }
                }
            });
        }
    }

    saveExpandedState();
    updateVisibleNodes();
    selectNode(element);

    const treeContainer = document.getElementById("directoryTree");
    treeContainer.focus();

    setTimeout(() => {
        element.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 100);
  }

  function hideQuickOpen() {
    overlay.style.display = "none";
  }

  input.addEventListener("input", updateResults);

  input.addEventListener("keydown", (event) => {
    const items = results.querySelectorAll(".quick-open-item");

    switch (event.key) {
      case "ArrowDown":
      case "n":
        if (event.key === "n" && !event.ctrlKey) break;
        event.preventDefault();
        selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
        updateSelection();
        break;

      case "ArrowUp":
      case "p":
        if (event.key === "p" && !event.ctrlKey) break;
        event.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, 0);
        updateSelection();
        break;

      case "Enter":
        if (selectedIndex >= 0) {
          const nodeId =
            items[selectedIndex].querySelector(".quick-open-id").textContent;
          navigateToNode(nodeId);
          hideQuickOpen();
        }
        break;

      case "Escape":
        hideQuickOpen();
        break;
    }
  });

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      hideQuickOpen();
    }
  });
}

function createTreeNode(nodeId, graphData, depth) {
    const container = document.createElement("div");
    const nodeData = graphData.nodes[nodeId];
    
    // Set indentation based on graph depth
    container.style.marginLeft = `${depth * 20}px`;

    const item = document.createElement("div");
    item.className = "tree-item";
    item.dataset.stableId = nodeId; // Store the stable ID consistently
    nodeIdToElement.set(nodeId, item); // Keep this for now, but we might want to rename the map

    // Get children from the edges
    const children = graphData.edges[nodeId] || [];
    
    // Add toggle if has children
    if (children.length > 0) {
        const toggle = document.createElement("span");
        toggle.className = "toggle";
        const isExpanded = expandedNodes.has(nodeId);
        toggle.textContent = isExpanded ? "▼" : "►";
        if (isExpanded) {
            toggle.classList.add("expanded");
        }
        item.appendChild(toggle);
    }

    // Create and append the text content
    const text = document.createElement("span");

    // Check if node has a non-empty ID
    if (nodeData.id) {
        const idSpan = document.createElement("span");
        idSpan.className = "node-id";
        idSpan.textContent = nodeData.id;
        text.appendChild(idSpan);
        text.appendChild(document.createTextNode(" ")); // Add space after ID
    } else {
        item.classList.add("non-id-node"); // Add class for non-ID nodes
    }

    // Add name
    if (nodeData.name) {
        const nameSpan = document.createElement("span");
        nameSpan.className = "node-name";
        nameSpan.textContent = nodeData.name;
        text.appendChild(nameSpan);
    }

    // Add extension if present
    if (nodeData.extension) {
        const extSpan = document.createElement("span");
        extSpan.className = "node-extension";
        extSpan.textContent = nodeData.extension;
        text.appendChild(extSpan);
    }

    item.appendChild(text);
    container.appendChild(item);

    // Add children container if needed
    if (children.length > 0) {
        const childrenContainer = document.createElement("div");
        childrenContainer.style.display = expandedNodes.has(nodeId) ? "block" : "none";
        childrenContainer.style.borderLeft = "2px solid var(--accent-gold)";
        childrenContainer.style.margin = "0 0 0 20px";
        childrenContainer.style.padding = "4px 0";

        // Sort children: ID nodes first, then alphabetically
        const sortedChildren = children.sort((a, b) => {
            const aIsId = graphData.id_nodes.includes(a);
            const bIsId = graphData.id_nodes.includes(b);
            if (aIsId !== bIsId) return bIsId - aIsId;
            return a.localeCompare(b);
        });

        sortedChildren.forEach(childId => {
            const childElement = createTreeNode(childId, graphData, depth + 1);
            childrenContainer.appendChild(childElement);
        });

        container.appendChild(childrenContainer);
    }

    // Add appropriate styling
    if (graphData.folder_nodes.includes(nodeId)) {
        item.classList.add("folder-node");
    }
    if (graphData.id_nodes.includes(nodeId)) {
        item.classList.add("id-node");
    }

    // Add styling for root and section nodes
    if (nodeId.length === 2) {
        item.classList.add("root-node");
        text.style.fontFamily = "var(--font-display)";
        text.style.fontSize = "1.2em";
        item.style.borderBottom = "2px double var(--separator-color)";
        text.style.fontWeight = "500";
    } else if (nodeId.endsWith("00")) {
        item.classList.add("section-node");
        text.style.fontStyle = "italic";
        item.style.borderBottom = "1px solid var(--separator-color)";
        item.style.backgroundColor = "var(--paper-shadow)";
    }

    // Add event listeners
    item.addEventListener("mouseenter", () => {
        const text = item.querySelector("span:not(.toggle)");
        text.style.transition = "all 0.3s ease";
        text.style.letterSpacing = "calc(var(--letter-spacing) * 1.5)";
        text.style.color = "var(--accent-gold)";
    });

    item.addEventListener("mouseleave", () => {
        const text = item.querySelector("span:not(.toggle)");
        text.style.letterSpacing = "var(--letter-spacing)";
        text.style.color = "var(--text-primary)";
    });

    // Click handlers
    item.addEventListener("click", (event) => {
        event.stopPropagation();
        selectNode(item, event.shiftKey);

        // Execute single-click action if configured
        const singleClickAction = settings.nodeActions['single-click-action'];
        if (singleClickAction) {
            registry.execute(singleClickAction, { selectedNodes });
        }

        if (children.length > 0) {
            const childrenContainer = container.querySelector("div:not(.tree-item)");
            const toggle = item.querySelector(".toggle");
            const isExpanded = childrenContainer.style.display === "block";
            childrenContainer.style.display = isExpanded ? "none" : "block";
            toggle.textContent = isExpanded ? "►" : "▼";
            toggle.classList.toggle("expanded");

            if (isExpanded) {
                expandedNodes.delete(nodeId);
            } else {
                expandedNodes.add(nodeId);
            }
            saveExpandedState();
            updateVisibleNodes();
        }
    });

    // Other event listeners
    item.addEventListener('mousedown', () => treeContainer.focus());
    
    item.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        const doubleClickAction = settings.nodeActions['double-click-action'];
        if (doubleClickAction) {
            registry.execute(doubleClickAction, { selectedNodes });
        }
    });

    return container;
}
function openInObsidian(nodeId) {
    const nodeData = currentGraph.nodes[nodeId];
    if (!nodeData) {
        console.error('Node data not found:', nodeId);
        return;
    }

    // Construct the filename with ID, name, and extension
    const fileName = `${nodeId} ${nodeData.name}${nodeData.extension}`;
    
    // Combine path and filename
    const relativePath = nodeData.path ? 
        window.path.join(nodeData.path, fileName) :
        fileName;
    
    console.log('Opening in Obsidian:', {
        nodeId,
        nodeData,
        fileName,
        relativePath
    });

    return window.api.openInObsidian(relativePath);
}

function getNodePath(element) {
  return element.dataset.stableId;
}

function getCommandContext(selectedNodes) {
  return {
    selectedNodes: Array.from(selectedNodes).map(node => ({
      path: getNodePath(node),
      isIdNode: !!node.dataset.nodeId
    }))
  };
}
