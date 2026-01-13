const { contextBridge, ipcRenderer } = require('electron');

console.log('[Preload] Script started'); // ✅ Log na początku

// Expose safe APIs to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Open file dialog
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  
  // Load GTFS file (returns { success, data } or { success: false, error })
  loadGTFSFile: (filePath) => ipcRenderer.invoke('load-gtfs-file', filePath),
  
  // Query routes
  queryRoutes: () => ipcRenderer.invoke('query-routes'),
  
  // Query trips for a route
  queryTrips: (params) => ipcRenderer.invoke('query-trips', params),
  
  // Query stop_times for a single trip
  queryStopTimes: (tripId) => ipcRenderer.invoke('query-stop-times', tripId),
  
  // Query stop_times for multiple trips in batch
  queryStopTimesBatch: (tripIds) => ipcRenderer.invoke('query-stop-times-batch', tripIds),
  
  // Query all stops
  queryAllStops: () => ipcRenderer.invoke('query-all-stops'),
  
  // Query all trips
  queryAllTrips: () => ipcRenderer.invoke('query-all-trips'),
  
  // Query shape data
  queryShape: (shapeId) => ipcRenderer.invoke('query-shape', shapeId),
  
  // Query available dates
  queryAvailableDates: () => ipcRenderer.invoke('query-available-dates'),
  
  // Query departures for a stop on a specific date
  queryDeparturesForStop: (params) => ipcRenderer.invoke('query-departures-for-stop', params),
  
  // Query directions for a route
  queryDirectionsForRoute: (routeId) => ipcRenderer.invoke('query-directions-for-route', routeId),
  
  // Query routes at a stop
  queryRoutesAtStop: (params) => ipcRenderer.invoke('query-routes-at-stop', params),
  
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
