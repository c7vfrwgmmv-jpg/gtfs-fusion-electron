const { contextBridge, ipcRenderer } = require('electron');

console.log('[Preload] Script started'); // ✅ Log na początku

// Expose safe APIs to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Open file dialog
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  
  // Load GTFS file (returns { success, data } or { success: false, error })
  loadGTFSFile: (filePath) => ipcRenderer.invoke('load-gtfs-file', filePath),
  
  // Query stop_times for multiple trips in batch
  queryStopTimesBatch: (tripIds) => ipcRenderer.invoke('query-stop-times-batch', tripIds),
  
  // Query all stops
  queryAllStops: () => ipcRenderer.invoke('query-all-stops'),
  
  // Listen to load progress updates
  onLoadProgress: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('gtfs-load-progress', subscription);
    
    // Return cleanup function
    return () => {
      ipcRenderer.removeListener('gtfs-load-progress', subscription);
    };
  },
  
  // Platform info
  platform: process.platform,
  isElectron: true
});

console.log('[Preload] ElectronAPI exposed to renderer'); // ✅ Log na końcu
