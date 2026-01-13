const { contextBridge, ipcRenderer } = require('electron');

console.log('[Preload] Script started'); // ✅ Log na początku

// Expose safe APIs to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Open file dialog
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  
  // Load GTFS file (returns { success, data } or { success: false, error })
  loadGTFSFile: (filePath) => ipcRenderer.invoke('load-gtfs-file', filePath),
  
  // Listen to load progress updates
  onLoadProgress: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('gtfs-load-progress', subscription);
    
    // Return cleanup function
    return () => {
      ipcRenderer.removeListener('gtfs-load-progress', subscription);
    };
  },
  
  // Query APIs for DuckDB
  queryRoutes: () => ipcRenderer.invoke('query-routes'),
  queryTrips: (filters) => ipcRenderer.invoke('query-trips', filters),
  queryStopTimes: (tripId) => ipcRenderer.invoke('query-stop-times', tripId),
  queryShape: (shapeId) => ipcRenderer.invoke('query-shape', shapeId),
  queryAvailableDates: () => ipcRenderer.invoke('query-available-dates'),
  
  // Platform info
  platform: process.platform,
  isElectron: true
});

console.log('[Preload] ElectronAPI exposed to renderer'); // ✅ Log na końcu