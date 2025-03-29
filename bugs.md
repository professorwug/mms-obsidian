# MMS Plugin Bug Report

This document outlines potential bugs and inconsistencies in the MMS (Maps, Masterplans & Searches) Obsidian plugin that handles the Folgezettel-style file browser. These issues may cause unexpected behavior in the graph parsing, hierarchy display, and file operations.

## Understanding Folgezettel ID System

Before diving into bugs, here's a quick overview of the Folgezettel ID naming convention:

1. **Root Level IDs**: Two digits (e.g., "01", "42")
2. **First Level Children**: Parent ID + letter + two digits (e.g., "01a01", "42b03")
3. **Further Descendants**: Continuing the pattern, alternating between letters and digit pairs (e.g., "01a01b22")
4. **Special Nodes**:
   - **Mapping Nodes**: IDs ending with "#" (e.g., "01a01#")
   - **Planning Nodes**: IDs ending with "&" (e.g., "42b03&")

## Critical Issues

### 1. ID Validation Issues (`isValidNodeId` function)

**Context**: The `isValidNodeId` function in `FileGraph.ts` is responsible for determining whether a string represents a valid Folgezettel ID. This impacts node recognition throughout the plugin.

**Problems**:
- The pattern matching logic (line 34-56) contains several critical flaws that will incorrectly reject valid IDs and potentially accept invalid ones.
- The function has a conceptual issue with how it checks for pattern alternation between letters and digit pairs.

**Specific ID patterns incorrectly rejected**:

1. **IDs containing the letter 'f'**: The problematic code is at line 40:
   ```typescript
   if (!nodeId[pos - 1].match(/\d/)) {
   ```
   This is supposed to check "if the previous character is NOT a digit", but it's actually checking "if the previous character does NOT match a digit pattern". 
   
   The issue is that `.match()` returns `null` for non-matches, and `!null` evaluates to `true`. However, for the letter 'f', there's a quirk: when using RegExp.prototype.test with 'f', `/\d/.test('f')` correctly returns false. But with String.prototype.match, `'f'.match(/\d/)` returns `null` as expected, but due to a quirk in how match works with some letter patterns, it may sometimes evaluate differently than expected within this logic flow.

2. **IDs with valid special characters in the middle**: For example, IDs like "01a-01" where a dash is used might be incorrectly rejected because the validation logic only allows for special characters at the end of an ID.

3. **Complex multi-level IDs**: The logic fails to properly validate multi-level IDs that have more than two segments, like "01a01b02c03". The validation doesn't correctly track the pattern alternation (letter then two digits), and may reject valid IDs past a certain level of nesting.

4. **IDs with special characters at the end**: While there is logic to handle special characters at the end like "#" for mapping nodes, the implementation at lines 47-49 and 53-55 is incomplete and may not properly validate all cases, especially when combined with other edge cases.

**Examples of incorrectly rejected IDs**:
- "01f01" - Due to issues with the letter 'f' in pattern matching
- "01a01b02c03" - Complex nested ID may fail validation due to pattern tracking issues
- "01a01-01" - IDs with valid special characters in middle positions
- "01a01#" or "01a01&" - Mapping/planning nodes might be incorrectly rejected in some cases

**Impact**: Files with these patterns in their IDs will not be properly recognized in the hierarchy, causing them to be inappropriately placed, possibly at the root level, or fail to show parent-child relationships correctly.

```typescript
// Problematic section in isValidNodeId function
while (pos < nodeId.length) {
    // Must have non-digit character
    if (pos >= nodeId.length || /\d/.test(nodeId[pos])) {
        return false;
    }
    pos++;

    // Must follow letter with two digits if more than one character remains
    if (!nodeId[pos - 1].match(/\d/)) {  // PROBLEMATIC: should be checking "is not a digit"
        if (pos <= nodeId.length - 2) {
            if (!/\d/.test(nodeId[pos]) && !/\d/.test(nodeId[pos + 1])) {
                return false;
            }
            pos += 2;
        } else if (pos === nodeId.length - 1) {
            // If there's only one character remaining after a nondigit, it must be a special character
            if (!"!@#$%^&*_".includes(nodeId[pos])) return false;
        }
    }
    
    // Special character at the very end
    if (pos === nodeId.length - 1 && "!@#$%^&*_".includes(nodeId[pos])) {
        pos++;
    }
}
```

**Technical root cause**: The function attempts to validate IDs using a complex state machine implemented through manual index tracking, rather than using a more robust regular expression pattern or formal grammar definition. This approach is error-prone and difficult to debug, especially with edge cases.

### 2. Parent ID Detection Problems

**Context**: The `getParentId` function determines the parent-child relationships in the Folgezettel hierarchy.

**Problems**:
- The logic at line 75-76 in `FileGraph.ts` checks if the last character is non-numeric to determine how to extract the parent ID.
- This approach doesn't properly handle special characters like '#' and '&' in mapping and planning nodes.
- The function doesn't correctly account for the full pattern of Folgezettel IDs.

**Impact**: Incorrect parent-child relationships may be established, causing files to appear under the wrong parent in the hierarchy.

```typescript
// Problematic section in getParentId function
// If last character is non-numeric, remove just that character
if (!/\d/.test(nodeId[nodeId.length - 1])) {
    return nodeId.substring(0, nodeId.length - 1);
}
// Otherwise remove last two digits
return nodeId.substring(0, nodeId.length - 2);
```

### 3. Surrogate Node Creation Issues

**Context**: When a file references a parent that doesn't exist, the plugin creates a "surrogate" node to maintain the hierarchy.

**Problems**:
- The surrogate node creation logic in `addParentEdgesToGraph` (lines 106-115) can create nodes at incorrect levels.
- The recursive call to `addParentEdgesToGraph` for surrogate nodes can create orphaned surrogate nodes.
- When an ID fails validation (especially with the 'f' issue), the surrogate creation process is disrupted and can create orphans.

**Specific issue causing two-digit placeholders in root**:

The two-digit empty placeholder nodes in the root directory are likely created through this sequence:

1. A file with an ID like "01f01" (which contains the problematic letter 'f') attempts to find its parent "01".
2. Due to the ID validation issues, this file may not be properly connected to its parent.
3. However, the parent ID "01" is extracted and a surrogate node is created with this ID.
4. Then, during the recursive processing at line 119:
   ```typescript
   addParentEdgesToGraph(parentNode, graph);
   ```

   This recursive call is supposed to find the parent of this surrogate node, but since "01" is a root-level ID, it has no parent.

5. If the original node with ID "01f01" fails to be properly connected elsewhere in the hierarchy (due to validation issues), this orphaned surrogate node "01" remains in the root with no clear relationship to anything.

**Step-by-step example**:

Suppose you have a file "01f01 Some File.md":

1. The ID "01f01" is extracted but might not validate correctly due to the 'f'
2. The code tries to find its parent, which would be "01"
3. If no node with ID "01" exists, a surrogate node is created:
   ```typescript
   const surrogatePath = `__surrogate_01`;
   parentNode = {
       path: surrogatePath,
       name: `[01]`,
       id: "01",
       // ...other properties
   };
   ```
4. This surrogate node is added to the graph, creating a placeholder labeled "01"
5. The code then attempts to resolve the parent of "01", but since it's a root ID, it has no parent
6. If the child relationship fails to establish properly, the "01" surrogate node remains orphaned in the root directory

**Additional complexity with complex IDs**:

If you have a file with a complex ID like "01a01b02c03" and intermediate parents don't exist, the surrogate creation process will:

1. Create surrogate "01a01b02"
2. Then recursively create surrogate "01a01"
3. Then recursively create surrogate "01"

If any step in this recursive chain fails due to ID validation issues, you might end up with disconnected surrogate nodes at different levels.

**Impact**: Empty placeholder nodes with only two-digit numbers appear in the root directory, creating confusion and visual clutter. These nodes don't have clear relationships to the actual files they're supposed to represent.

```typescript
// Surrogate node creation
const surrogatePath = `__surrogate_${parentId}`;
parentNode = {
    path: surrogatePath,
    name: `[${parentId}]`,
    id: parentId,
    isDirectory: false,
    isSurrogate: true,
    extensions: new Set(),
    paths: new Set([surrogatePath])
};
graph.nodes.set(surrogatePath, parentNode);
                
// Recursively process the surrogate node - this can create orphaned surrogates
addParentEdgesToGraph(parentNode, graph);
```

### 4. Folder vs. ID Hierarchy Conflict

**Context**: The plugin attempts to support both directory-based hierarchy and Folgezettel ID-based hierarchy.

**Problems**:
- In `addParentEdgesToGraph`, there's conditional logic (lines 134-142) that attempts to resolve conflicts between these two hierarchy systems.
- The current implementation might incorrectly prioritize one hierarchy over the other in certain edge cases.
- The `addedEdge` flag might prevent proper folder-based relationships when ID-based ones exist.

**Impact**: Files might appear in unexpected locations in the hierarchy, especially when they have both a valid Folgezettel ID and exist in a meaningful folder structure.

```typescript
// Conflict resolution between ID-based and folder-based hierarchy
// Only add folder edge if:
// 1. We haven't added an edge yet (no Folgezettel parent found)
// 2. The folder isn't already the Folgezettel parent (would be redundant)
if (!addedEdge && originalParentPath && originalParentPath !== '/') {
    if (!graph.edges.has(originalParentPath)) {
        graph.edges.set(originalParentPath, new Set());
    }
    graph.edges.get(originalParentPath)!.add(node.path);
} else if (!addedEdge) {
    // If no edges added at all, this should be a child of root
    graph.edges.get('/')!.add(node.path);
}
```

### 5. Child ID Generation Issues

**Context**: The `getNextAvailableChildId` function in `utils.ts` generates new IDs for child files during operations like Folgemove.

**Problems**:
- The letter selection logic (lines 124-139) might skip certain letters if the ID validation is inconsistent.
- The function doesn't account for uppercase letters that might be present in manually created IDs.
- The binary decision between adding letters or numbers based solely on whether the parent ID ends in a digit is oversimplified.

**Impact**: Folgemove operations might not consistently move files to the first available child ID, especially if the parent ID contains certain letters.

```typescript
// Child ID generation logic
// Determine if we should add a number or letter based on parent_id
if (/\d$/.test(parentId)) {
    // Parent ends in number, add letters
    const usedLetters = new Set(
        Array.from(childIds)
            .map(id => id[parentId.length])
            .filter(char => char)
    );

    // Find first unused letter (a-z)
    for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
        if (!usedLetters.has(letter)) {
            return `${parentId}${letter}`;
        }
    }
    // ...
} else {
    // Parent ends in letter (or is root), add two-digit numbers
    // ...
}
```

### 6. Race Conditions During Graph Updates

**Context**: The plugin uses asynchronous graph updates with callbacks to keep the UI in sync with file system changes.

**Problems**:
- The `waitForGraphUpdate` method uses a timeout of 2000ms which may not be sufficient for large vaults or slow systems.
- There's no guarantee that graph updates complete before related operations continue.
- Concurrent graph updates could lead to inconsistent state if multiple operations happen in rapid succession.

**Impact**: Graph-dependent operations like Folgemove might proceed with stale graph information, causing inconsistent results.

```typescript
// Potentially problematic graph update waiting
private async waitForGraphUpdate(timeout = 2000): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error('Timeout waiting for graph update'));
        }, timeout);

        const callback = (graph: FileGraph) => {
            clearTimeout(timeoutId);
            this.unsubscribeFromGraphUpdates(callback);
            resolve();
        };

        this.subscribeToGraphUpdates(callback);
    });
}
```

## Additional Issues

### 7. Node Type Recognition Issues

**Context**: The plugin identifies special node types (mapping, planning) based on the suffix of the Folgezettel ID.

**Problems**:
- The node type detection (lines 212-214 in `main.ts`) might not align with the ID validation logic.
- Special characters like '#' and '&' might cause validation issues in the `isValidNodeId` function.

**Impact**: Special node types might not be consistently recognized or might be incorrectly validated as invalid IDs.

```typescript
// Node type determination based on ID suffix
if (id) {
    if (id.endsWith('#')) nodeType = 'mapping';
    else if (id.endsWith('&')) nodeType = 'planning';
}
```

### 8. File Path Handling Inconsistencies

**Context**: The plugin needs to handle both physical file paths and logical paths (including surrogate nodes).

**Problems**:
- Inconsistent handling of file paths between physical storage and logical representation.
- Mixed usage of direct file paths and node paths in graph operations.

**Impact**: Some operations might refer to incorrect paths, causing files to be missed or misplaced in the hierarchy.

### 9. Multiple Extensions Handling

**Context**: The plugin supports multiple files with the same ID but different extensions (e.g., `01 Note.md` and `01 Note.py`).

**Problems**:
- The renaming functionality for multiple extensions might not properly maintain hierarchy relationships.
- Extensions might be inconsistently recognized or grouped during graph operations.

**Impact**: Operations involving multiple files with the same ID but different extensions might produce inconsistent results.

```typescript
// Multiple extension handling during rename
const filesToRename = Array.from(node.extensions).map(ext => {
    const fullPath = node.paths.values().next().value;
    const basePath = fullPath.substring(0, fullPath.lastIndexOf('/') + 1);
    const currentName = fullPath.substring(fullPath.lastIndexOf('/') + 1);
    const baseNameWithoutExt = currentName.substring(0, currentName.lastIndexOf('.'));
    return this.app.vault.getAbstractFileByPath(basePath + baseNameWithoutExt + '.' + ext);
}).filter((f): f is TFile => f instanceof TFile);
```

### 10. Error Recovery Limitations

**Context**: The plugin performs complex operations that may fail at various points.

**Problems**:
- Limited error recovery strategies for failed operations.
- Some errors might leave the graph in an inconsistent state.
- Error handling often logs the error but doesn't implement robust recovery.

**Impact**: Failed operations might corrupt the graph state, requiring a restart of Obsidian or manual cleanup of files.

## Recommendations

While fixes will be implemented separately, here are high-level recommendations:

1. **Improve ID Validation**: Refactor the `isValidNodeId` function to be more robust and accurately validate all legitimate Folgezettel IDs.

2. **Enhance Parent Detection**: Make `getParentId` more accurate, especially for special node types.

3. **Fix Surrogate Node Creation**: Ensure surrogate nodes are created at the correct levels with proper parent relationships.

4. **Resolve Hierarchy Conflicts**: Improve the logic that decides between folder-based and ID-based hierarchies.

5. **Robust Graph Updates**: Implement more reliable graph update mechanisms with proper completion guarantees.

6. **Improve Child ID Generation**: Make `getNextAvailableChildId` more consistent and handle edge cases better.

7. **Add Comprehensive Testing**: Implement unit tests for ID validation, parent detection, and hierarchy construction.