console.log('MAIN STARTED');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const AdmZip = require('adm-zip');
const fs = require('fs');
const yauzl = require('yauzl');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // ✅ DODAJ TO:
      nodeIntegrationInWorker: false,
      v8CacheOptions: 'none'
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.webContents.openDevTools();
}

// ════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS (z utils.js, ale dla Node.js)
// ════════════════════════════════════════════════════════════════

function normalizeKey(key) {
  if (!key) return '';
  let normalized = String(key).toLowerCase().trim();
  normalized = normalized.replace(/\s+/g, '_');
  normalized = normalized.replace(/[^\w_]/g, '');
  
  // Aliases dla popularnych wariantów
  const aliases = {
    'routeid': 'route_id',
    'tripid': 'trip_id',
    'serviceid': 'service_id',
    'stopid': 'stop_id',
    'shapeid': 'shape_id'
  };
  
  return aliases[normalized] || normalized;
}

function normalizeRecord(row) {
  const normalized = {};
  Object.keys(row).forEach(key => {
    const normalizedKey = normalizeKey(key);
    normalized[normalizedKey] = row[key];
  });
  return normalized;
}

// ════════════════════════════════════════════════════════════════
// CSV PARSER (with quote handling)
// ════════════════════════════════════════════════════════════════

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  result.push(current.trim());
  return result;
}

function parseCSV(text) {
  const lines = text.split('\n');
  if (lines.length === 0) return [];
  
  // Remove BOM if present
  const firstLine = lines[0].replace(/^\uFEFF/, '');
  const headers = parseCSVLine(firstLine);
  const result = [];
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const values = parseCSVLine(line);
    const row = {};
    
    headers.forEach((header, idx) => {
      row[header] = values[idx] || '';
    });
    
    result.push(normalizeRecord(row));
  }
  
  return result;
}

// ════════════════════════════════════════════════════════════════
// STREAMING STOP_TIMES PARSER (dla bardzo dużych plików)
// ════════════════════════════════════════════════════════════════

async function parseStopTimesStreaming(zipPath, onProgress) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      
      const stopTimesIndex = {};
      let headers = null;
      let lineBuffer = '';
      let rowCount = 0;
      
      zipfile.readEntry();
      
      zipfile.on('entry', (entry) => {
        // Skip directories and other files
        if (!/stop_times\.txt$/i.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }
        
        console.log(`[Main] Streaming: ${entry.fileName}`);
        
        zipfile.openReadStream(entry, (err, readStream) => {
          if (err) return reject(err);
          
          readStream.setEncoding('utf8');
          
          readStream.on('data', (chunk) => {
            lineBuffer += chunk;
            const lines = lineBuffer.split('\n');
            
            // Keep last incomplete line in buffer
            lineBuffer = lines.pop() || '';
            
            lines.forEach((line) => {
              line = line.trim();
              if (!line) return;
              
              // First line = headers
              if (!headers) {
                const rawHeaders = parseCSVLine(line.replace(/^\uFEFF/, ''));
                headers = {
                  tripIdx: -1,
                  stopIdx: -1,
                  seqIdx: -1,
                  arrIdx: -1,
                  depIdx: -1,
                  pickupIdx: -1,
                  dropoffIdx: -1
                };
                
                rawHeaders.forEach((h, i) => {
                  const normalized = normalizeKey(h);
                  if (normalized === 'trip_id') headers.tripIdx = i;
                  else if (normalized === 'stop_id') headers.stopIdx = i;
                  else if (normalized === 'stop_sequence') headers.seqIdx = i;
                  else if (normalized === 'arrival_time') headers.arrIdx = i;
                  else if (normalized === 'departure_time') headers.depIdx = i;
                  else if (normalized === 'pickup_type') headers.pickupIdx = i;
                  else if (normalized === 'drop_off_type') headers.dropoffIdx = i;
                });
                return;
              }
              
              // Parse data row
              const cols = parseCSVLine(line);
              const tripId = cols[headers.tripIdx];
              if (!tripId) return;
              
              if (!stopTimesIndex[tripId]) stopTimesIndex[tripId] = [];
              
              stopTimesIndex[tripId].push({
                stop_id: cols[headers.stopIdx] || '',
                arrival_time: cols[headers.arrIdx] || '',
                departure_time: cols[headers.depIdx] || '',
                stop_sequence: parseInt(cols[headers.seqIdx] || '0', 10),
                pickup_type: cols[headers.pickupIdx] || '0',
                drop_off_type: cols[headers.dropoffIdx] || '0'
              });
              
              rowCount++;
              
              // Progress every 100k rows
              if (rowCount % 100000 === 0 && onProgress) {
                onProgress({
                  step: `Parsing stop_times... ${rowCount.toLocaleString()} rows`,
                  percent: 60 + Math.min(30, Math.floor(rowCount / 500000))
                });
              }
            });
          });
          
          readStream.on('end', () => {
            // Process last line if exists
            if (lineBuffer.trim() && headers) {
              const cols = parseCSVLine(lineBuffer.trim());
              const tripId = cols[headers.tripIdx];
              if (tripId) {
                if (!stopTimesIndex[tripId]) stopTimesIndex[tripId] = [];
                stopTimesIndex[tripId].push({
                  stop_id: cols[headers.stopIdx] || '',
                  arrival_time: cols[headers.arrIdx] || '',
                  departure_time: cols[headers.depIdx] || '',
                  stop_sequence: parseInt(cols[headers.seqIdx] || '0', 10),
                  pickup_type: cols[headers.pickupIdx] || '0',
                  drop_off_type: cols[headers.dropoffIdx] || '0'
                });
              }
            }
            
            // Sort each trip's stops
            Object.keys(stopTimesIndex).forEach(tripId => {
              stopTimesIndex[tripId].sort((a, b) => a.stop_sequence - b.stop_sequence);
            });
            
            console.log(`[Main] Parsed ${Object.keys(stopTimesIndex).length} trips, ${rowCount} total rows`);
            resolve(stopTimesIndex);
          });
          
          readStream.on('error', reject);
        });
      });
      
      zipfile.on('end', () => {
        if (!headers) {
          reject(new Error('stop_times.txt not found in archive'));
        }
      });
      
      zipfile.on('error', reject);
    });
  });
}

// ════════════════════════════════════════════════════════════════
// STOP_TIMES SPECIALIZED PARSER (optimized for medium files)
// ════════════════════════════════════════════════════════════════

function parseStopTimesOptimized(text, onProgress) {
  const lines = text.split('\n');
  if (lines.length === 0) return {};
  
  // Parse header
  const firstLine = lines[0].replace(/^\uFEFF/, '');
  const rawHeaders = parseCSVLine(firstLine);
  
  // Find column indices
  const headers = {
    tripIdx: -1,
    stopIdx: -1,
    seqIdx: -1,
    arrIdx: -1,
    depIdx: -1,
    pickupIdx: -1,
    dropoffIdx: -1
  };
  
  rawHeaders.forEach((h, i) => {
    const normalized = normalizeKey(h);
    if (normalized === 'trip_id') headers.tripIdx = i;
    else if (normalized === 'stop_id') headers.stopIdx = i;
    else if (normalized === 'stop_sequence') headers.seqIdx = i;
    else if (normalized === 'arrival_time') headers.arrIdx = i;
    else if (normalized === 'departure_time') headers.depIdx = i;
    else if (normalized === 'pickup_type') headers.pickupIdx = i;
    else if (normalized === 'drop_off_type') headers.dropoffIdx = i;
  });
  
  if (headers.tripIdx === -1 || headers.stopIdx === -1) {
    console.error('Missing required columns in stop_times.txt');
    return {};
  }
  
  const stopTimesIndex = {};
  const chunkSize = 50000;
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const cols = parseCSVLine(line);
    
    const tripId = cols[headers.tripIdx];
    if (!tripId) continue;
    
    if (!stopTimesIndex[tripId]) stopTimesIndex[tripId] = [];
    
    stopTimesIndex[tripId].push({
      stop_id: cols[headers.stopIdx] || '',
      arrival_time: cols[headers.arrIdx] || '',
      departure_time: cols[headers.depIdx] || '',
      stop_sequence: parseInt(cols[headers.seqIdx] || '0', 10),
      pickup_type: cols[headers.pickupIdx] || '0',
      drop_off_type: cols[headers.dropoffIdx] || '0'
    });
    
    // Progress update every chunk
    if (i % chunkSize === 0 && onProgress) {
      const percent = 60 + Math.floor(((i / lines.length) * 30));
      onProgress({
        step: `Parsing stop_times... ${i.toLocaleString()}/${lines.length.toLocaleString()} rows`,
        percent
      });
    }
  }
  
  // Sort each trip's stops by sequence
  Object.keys(stopTimesIndex).forEach(tripId => {
    stopTimesIndex[tripId].sort((a, b) => a.stop_sequence - b.stop_sequence);
  });
  
  console.log(`[Main] Parsed ${Object.keys(stopTimesIndex).length} trips with stop_times`);
  
  return stopTimesIndex;
}

// ════════════════════════════════════════════════════════════════
// SHAPES PARSER (optimized)
// ════════════════════════════════════════════════════════════════

function parseShapes(text, onProgress) {
  const lines = text.split('\n');
  if (lines.length === 0) return {};
  
  const firstLine = lines[0].replace(/^\uFEFF/, '');
  const rawHeaders = parseCSVLine(firstLine);
  
  const headers = {
    shapeIdx: -1,
    latIdx: -1,
    lonIdx: -1,
    seqIdx: -1
  };
  
  rawHeaders.forEach((h, i) => {
    const normalized = normalizeKey(h);
    if (normalized === 'shape_id') headers.shapeIdx = i;
    else if (normalized === 'shape_pt_lat') headers.latIdx = i;
    else if (normalized === 'shape_pt_lon') headers.lonIdx = i;
    else if (normalized === 'shape_pt_sequence') headers.seqIdx = i;
  });
  
  if (headers.shapeIdx === -1 || headers.latIdx === -1 || headers.lonIdx === -1) {
    console.error('Missing required columns in shapes.txt');
    return {};
  }
  
  const shapesIndex = {};
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const cols = parseCSVLine(line);
    
    const shapeId = cols[headers.shapeIdx];
    if (!shapeId) continue;
    
    if (!shapesIndex[shapeId]) shapesIndex[shapeId] = [];
    
    const lat = parseFloat(cols[headers.latIdx]);
    const lon = parseFloat(cols[headers.lonIdx]);
    const seq = parseInt(cols[headers.seqIdx] || '0', 10);
    
    if (!isNaN(lat) && !isNaN(lon)) {
      shapesIndex[shapeId].push([lat, lon, seq]);
    }
    
    // Progress update
    if (i % 100000 === 0 && onProgress) {
      onProgress({
        step: `Parsing shapes... ${i.toLocaleString()} points`,
        percent: 92
      });
    }
  }
  
  // Sort by sequence
  Object.keys(shapesIndex).forEach(shapeId => {
    shapesIndex[shapeId].sort((a, b) => a[2] - b[2]);
    // Remove sequence number, keep only [lat, lon]
    shapesIndex[shapeId] = shapesIndex[shapeId].map(([lat, lon]) => [lat, lon]);
  });
  
  console.log(`[Main] Parsed ${Object.keys(shapesIndex).length} shapes`);
  
  return shapesIndex;
}

// ════════════════════════════════════════════════════════════════
// MAIN GTFS LOADING FUNCTION
// ════════════════════════════════════════════════════════════════

async function loadGTFSFile(filePath) {
  const startTime = Date.now();
  
  try {
    console.log('[Main] Loading GTFS from:', filePath);
    
    // Progress helper
    const sendProgress = (step, percent) => {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('gtfs-load-progress', { step, percent });
      }
    };
    
    // Check file size to determine parsing strategy
    const stats = fs.statSync(filePath);
    const fileSizeMB = stats.size / (1024 * 1024);
    console.log(`[Main] File size: ${fileSizeMB.toFixed(2)} MB`);
    
    const useStreaming = fileSizeMB > 100; // Use streaming for files > 100MB
    
    if (useStreaming) {
      console.log('[Main] Large file detected - will use streaming parser for stop_times');
    }
    
    // 1. UNZIP
    sendProgress('Unzipping archive...', 0);
    
    const zip = new AdmZip(filePath);
    const zipEntries = zip.getEntries();
    
    console.log(`[Main] Found ${zipEntries.length} files in archive`);
    
    // Helper to find and extract file
    const getFileText = (filename, allowLarge = false) => {
      const entry = zipEntries.find(e => {
        const entryName = e.entryName.toLowerCase();
        return entryName === filename.toLowerCase() || 
               entryName.endsWith('/' + filename.toLowerCase());
      });
      
      if (!entry) {
        console.warn(`[Main] File not found: ${filename}`);
        return null;
      }
      
      // Check size before loading into memory
      const entrySizeMB = entry.header.size / (1024 * 1024);
      
      if (!allowLarge && entrySizeMB > 200) {
        console.warn(`[Main] ${filename} is ${entrySizeMB.toFixed(2)}MB - too large for memory extraction`);
        return null; // Will be handled by streaming parser
      }
      
      console.log(`[Main] Extracting: ${entry.entryName} (${entrySizeMB.toFixed(2)}MB)`);
      
      try {
        return entry.getData().toString('utf8');
      } catch (err) {
        console.error(`[Main] Failed to extract ${filename}:`, err.message);
        return null;
      }
    };
    
    sendProgress('Extracting files...', 10);
    
    // 2. EXTRACT REQUIRED FILES
    const routesText = getFileText('routes.txt');
    const tripsText = getFileText('trips.txt');
    const stopsText = getFileText('stops.txt');
    let stopTimesText = useStreaming ? null : getFileText('stop_times.txt');
    
    if (!routesText || !tripsText || !stopsText) {
      throw new Error('Missing required GTFS files (routes.txt, trips.txt, stops.txt)');
    }
    
    // Extract optional files
    const calendarText = getFileText('calendar.txt');
    const calendarDatesText = getFileText('calendar_dates.txt');
    const agenciesText = getFileText('agency.txt');
    const shapesText = getFileText('shapes.txt');
    
    // 3. PARSE FILES
    sendProgress('Parsing routes...', 20);
    const routes = parseCSV(routesText);
    console.log(`[Main] Parsed ${routes.length} routes`);
    
    sendProgress('Parsing trips...', 30);
    const trips = parseCSV(tripsText);
    console.log(`[Main] Parsed ${trips.length} trips`);
    
    sendProgress('Parsing stops...', 40);
    const stops = parseCSV(stopsText);
    console.log(`[Main] Parsed ${stops.length} stops`);
    
    sendProgress('Parsing calendar...', 50);
    const calendar = calendarText ? parseCSV(calendarText) : [];
    const calendarDates = calendarDatesText ? parseCSV(calendarDatesText) : [];
    const agencies = agenciesText ? parseCSV(agenciesText) : [];
    
    console.log(`[Main] Parsed ${calendar.length} calendar entries, ${calendarDates.length} calendar_dates, ${agencies.length} agencies`);
    
    // 4. PARSE STOP_TIMES (large file - choose strategy)
    sendProgress('Parsing stop_times (this may take a while)...', 60);
    
    let stopTimesIndex;
    
    if (useStreaming || stopTimesText === null) {
      console.log('[Main] Using streaming parser for stop_times');
      stopTimesIndex = await parseStopTimesStreaming(filePath, sendProgress);
    } else {
      console.log('[Main] Using in-memory parser for stop_times');
      stopTimesIndex = parseStopTimesOptimized(stopTimesText, sendProgress);
    }
    
    // 5. PARSE SHAPES (optional, large file)
    let shapesIndex = {};
    if (shapesText) {
      sendProgress('Parsing shapes...', 92);
      shapesIndex = parseShapes(shapesText, sendProgress);
    }
    
    // 6. BUILD INDEXES
    sendProgress('Building indexes...', 95);
    
    const stopsIndex = {};
    stops.forEach(s => {
      if (s.stop_id) stopsIndex[s.stop_id] = s;
    });
    
    const tripsIndex = {};
    trips.forEach(t => {
      const rid = t.route_id;
      if (!rid) return;
      if (!tripsIndex[rid]) tripsIndex[rid] = [];
      tripsIndex[rid].push(t);
    });
    
    const agenciesIndex = {};
    agencies.forEach(a => {
      if (a.agency_id || a.agency_name) {
        agenciesIndex[a.agency_id || a.agency_name] = a;
      }
    });
    
    // Build calendar_dates index
    const calendarDatesByDateIndex = new Map();
    calendarDates.forEach(cd => {
      if (!cd.date) return;
      if (!calendarDatesByDateIndex.has(cd.date)) {
        calendarDatesByDateIndex.set(cd.date, []);
      }
      calendarDatesByDateIndex.get(cd.date).push(cd);
    });
    
    // 6.5 BUILD STOP-TO-ROUTES MAPPING (optimized algorithm)
    // This helps the renderer show all stops with their serving routes
    // without needing to load all stop_times into memory
    sendProgress('Building stop-to-routes index...', 97);
    console.log('[Main] Building stop-to-routes index...');
    const mappingStartTime = Date.now();
    
    const stopToRoutes = {};
    const totalRoutes = routes.length;
    let processedRoutes = 0;
    
    // Build route info lookup once (avoid repeated object creation)
    const routeInfoMap = {};
    routes.forEach(route => {
      routeInfoMap[route.route_id] = {
        route_id: route.route_id,
        route_short_name: route.route_short_name,
        route_long_name: route.route_long_name,
        route_type: route.route_type,
        route_color: route.route_color,
        route_text_color: route.route_text_color
      };
    });
    
    // For each route, find all stops it serves (optimized with single pass)
    routes.forEach((route, index) => {
      const routeTrips = tripsIndex[route.route_id] || [];
      const routeInfo = routeInfoMap[route.route_id];
      
      // Use Set for O(1) lookups instead of array searches
      const seenStops = new Set();
      
      // Single pass through all trips for this route
      for (let i = 0; i < routeTrips.length; i++) {
        const trip = routeTrips[i];
        const tripStopTimes = stopTimesIndex[trip.trip_id];
        
        if (tripStopTimes) {
          for (let j = 0; j < tripStopTimes.length; j++) {
            const stopId = tripStopTimes[j].stop_id;
            if (stopId && !seenStops.has(stopId)) {
              seenStops.add(stopId);
              
              // Initialize array if needed and add route info
              if (!stopToRoutes[stopId]) {
                stopToRoutes[stopId] = [routeInfo];
              } else {
                stopToRoutes[stopId].push(routeInfo);
              }
            }
          }
        }
      }
      
      // Send progress updates every 100 routes to reduce IPC overhead
      processedRoutes++;
      if (processedRoutes % 100 === 0 || processedRoutes === totalRoutes) {
        const percent = 97 + Math.floor((processedRoutes / totalRoutes) * 2);
        sendProgress(`Building stop-to-routes index... ${processedRoutes}/${totalRoutes}`, percent);
      }
    });
    
    const mappingDuration = Date.now() - mappingStartTime;
    console.log(`[Main] Built stop-to-routes mapping for ${Object.keys(stopToRoutes).length} stops in ${mappingDuration}ms`);
    
    // 7. PREPARE FINAL DATA
    const gtfsData = {
      routes,
      trips,
      stops,
      stopsIndex,
      tripsIndex,
      stopTimesIndex,
      stopToRoutes, // Add the stop-to-routes mapping
      calendar,
      calendarDates,
      calendarDatesByDateIndex: Array.from(calendarDatesByDateIndex.entries()), // Convert Map to Array for IPC
      agencies,
      agenciesIndex,
      shapesIndex
    };
    
    sendProgress('Complete!', 100);
    
    const duration = Date.now() - startTime;
    console.log(`[Main] GTFS loaded successfully in ${(duration / 1000).toFixed(2)}s`);
    console.log(`[Main] Stats: ${routes.length} routes, ${trips.length} trips, ${stops.length} stops, ${Object.keys(stopTimesIndex).length} trips with stop_times`);
    
    return gtfsData;
    
  } catch (error) {
    console.error('[Main] Error loading GTFS:', error);
    throw error;
  }
}

// ════════════════════════════════════════════════════════════════
// GLOBAL DATA STORE (for IPC queries)
// ════════════════════════════════════════════════════════════════

let cachedGtfsData = null;

// ════════════════════════════════════════════════════════════════
// IPC HANDLERS
// ════════════════════════════════════════════════════════════════

// File dialog
ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'GTFS Archives', extensions: ['zip'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    title: 'Select GTFS ZIP file'
  });
  
  if (result.canceled) {
    return null;
  }
  
  return result.filePaths[0];
});

// Load GTFS file
ipcMain.handle('load-gtfs-file', async (event, filePath) => {
  try {
    const data = await loadGTFSFile(filePath);
    // Cache the data for IPC queries
    cachedGtfsData = data;
    return { success: true, data };
  } catch (error) {
    console.error('[Main] GTFS load failed:', error);
    
    // Send error notification
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('gtfs-load-progress', {
        step: 'Error: ' + error.message,
        percent: 0,
        error: true
      });
    }
    
    return { 
      success: false, 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    };
  }
});

// Query stop_times for multiple trips in a single batch
ipcMain.handle('query-stop-times-batch', async (event, tripIds) => {
  console.log(`[SQL] query-stop-times-batch START for ${tripIds.length} trips`);
  const startTime = Date.now();
  
  if (!cachedGtfsData || !cachedGtfsData.stopTimesIndex) {
    console.warn('[SQL] No GTFS data loaded');
    return {};
  }
  
  const result = {};
  const stopsIndex = cachedGtfsData.stopsIndex || {};
  
  // Fetch all stop_times for requested trips
  tripIds.forEach(tripId => {
    const stopTimes = cachedGtfsData.stopTimesIndex[tripId];
    if (stopTimes && stopTimes.length > 0) {
      // Enrich with stop information
      result[tripId] = stopTimes.map(st => ({
        trip_id: tripId,
        arrival_time: st.arrival_time,
        departure_time: st.departure_time,
        stop_id: st.stop_id,
        stop_sequence: st.stop_sequence,
        stop_name: stopsIndex[st.stop_id]?.stop_name || '',
        stop_lat: stopsIndex[st.stop_id]?.stop_lat || '',
        stop_lon: stopsIndex[st.stop_id]?.stop_lon || '',
        pickup_type: st.pickup_type,
        drop_off_type: st.drop_off_type
      }));
    }
  });
  
  const duration = Date.now() - startTime;
  const totalStopTimes = Object.values(result).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`[SQL] query-stop-times-batch SUCCESS: ${totalStopTimes} stop_times in ${duration}ms`);
  
  return result;
});

// Query all stops from the GTFS data
ipcMain.handle('query-all-stops', async (event) => {
  console.log('[SQL] query-all-stops START');
  const startTime = Date.now();
  
  if (!cachedGtfsData || !cachedGtfsData.stops) {
    console.warn('[SQL] No GTFS data loaded');
    return [];
  }
  
  // Return all stops, sorted by name
  const allStops = [...cachedGtfsData.stops].sort((a, b) => 
    (a.stop_name || '').localeCompare(b.stop_name || '')
  );
  
  const duration = Date.now() - startTime;
  console.log(`[SQL] query-all-stops SUCCESS: ${allStops.length} stops in ${duration}ms`);
  
  return allStops;
});

// ════════════════════════════════════════════════════════════════
// APP LIFECYCLE
// ════════════════════════════════════════════════════════════════

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});