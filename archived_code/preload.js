const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');

async function checkExistingServer(port) {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        const data = await response.json();
        return data.status === 'ok' && data.service === 'zettelfiles';
    } catch (error) {
        return false;
    }
}

async function startPythonServer() {
    const port = 8000;
    
    // Check if server already exists
    const serverExists = await checkExistingServer(port);
    if (serverExists) {
        console.log('Found existing zettelfiles server');
        return;
    }

    console.log('Starting new zettelfiles server...');
    // Server spawn code would go here
}

contextBridge.exposeInMainWorld('path', {
    basename: path.basename,
    dirname: path.dirname,
    join: path.join
});

contextBridge.exposeInMainWorld('api', {
    loadDirectory: async (path) => {
        console.log("loadDirectory called with path:", path);
        const result = await ipcRenderer.invoke('load-directory', path);
        console.log("loadDirectory result:", result);
        return result;
    },
    selectDirectory: () => ipcRenderer.invoke('select-directory'),
    onDirectorySelected: (callback) => ipcRenderer.on('directory-selected', (event, path) => callback(path)),
    renameFile: async (oldPath, newPath) => {
        console.log("renameFile called:", { oldPath, newPath });
        const result = await ipcRenderer.invoke('rename-file', oldPath, newPath);
        console.log("renameFile result:", result);
        return result;
    },
    createFile: async (path) => {
        console.log("createFile called with path:", path);
        const result = await ipcRenderer.invoke('create-file', path);
        console.log("createFile result:", result);
        return result;
    },
    openFiles: async (paths) => {
        console.log("openFiles called with paths:", paths);
        return await ipcRenderer.invoke('open-files', paths);
    },
    deleteFiles: async (paths) => {
        console.log("deleteFiles called with paths:", paths);
        return await ipcRenderer.invoke('delete-files', paths);
    },
    openInObsidian: async (path) => {
        console.log("openInObsidian called with path:", path);
        const result = await ipcRenderer.invoke('open-in-obsidian', path);
        console.log("openInObsidian result:", result);
        return result;
    },
    moveFiles: async (sourceIds, targetId) => {
        console.log("moveFiles called:", { sourceIds, targetId });
        const result = await ipcRenderer.invoke('move-files', sourceIds, targetId);
        console.log("moveFiles result:", result);
        return result;
    },
    executeMoveOperation: async (sourceIds, targetId) => {
        console.log("executeMoveOperation called:", { sourceIds, targetId });
        const result = await ipcRenderer.invoke('execute-move-operation', sourceIds, targetId);
        console.log("executeMoveOperation result:", result);
        return result;
    },
    changeFolgezettelId: async (oldId, newId) => {
        console.log("changeFolgezettelId called:", { oldId, newId });
        const result = await ipcRenderer.invoke('change-folgezettel-id', oldId, newId);
        console.log("changeFolgezettelId result:", result);
        return result;
    },
    getGraphData: () => ipcRenderer.invoke('get-graph-data'),
    getBaseDirectory: () => ipcRenderer.invoke('get-base-directory'),
    adoptOrphans: async () => {
        console.log("adoptOrphans called");
        const result = await ipcRenderer.invoke('adopt-orphans');
        console.log("adoptOrphans result:", result);
        return result;
    },
    onExecuteCommand: (callback) => ipcRenderer.on('execute-command', (event, command) => callback(command)),
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    closeSettings: () => ipcRenderer.invoke('close-settings'),
    onSettingsChanged: (callback) => ipcRenderer.on('settings-changed', (event, settings) => callback(settings)),
    getPythonPath: () => ipcRenderer.invoke('get-python-path'),
    savePythonPath: (path) => ipcRenderer.invoke('save-python-path', path),
    selectPythonPath: () => ipcRenderer.invoke('select-python-path')
});


contextBridge.exposeInMainWorld('commandRegistry', {
    execute: async (commandName, context) => {
        console.log('Executing command via bridge:', commandName);
        return await ipcRenderer.invoke('execute-command', commandName, context);
    },
    getAllCommands: async () => {
        console.log('Getting commands via bridge');
        return await ipcRenderer.invoke('get-all-commands');
    }
});
