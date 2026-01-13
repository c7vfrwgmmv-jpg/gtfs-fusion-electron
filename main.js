console.log('MAIN STARTED');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const AdmZip = require('adm-zip');
const fs = require('fs');
const yauzl = require('yauzl');
const duckdb = require('duckdb');
const crypto = require('crypto');
const os = require('os');

let mainWindow;
let db = null;

const CACHE_DIR = path.join(app.getPath('userData'), 'cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

async function computeFingerprint(filePath) {
  const stats = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  const bufferSize = Math.min(10 * 1024 * 1024, stats.size);
  const buffer = Buffer.alloc(bufferSize);
  fs.readSync(fd, buffer, 0, bufferSize, 0);
  fs.closeSync(fd);
  
  const hash = crypto.createHash('sha256');
  hash.update(buffer);
  hash.update(stats.size.toString());
  hash.update(stats.mtime.toISOString());
  
  return hash.digest('hex').substring(0, 16);
}

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
// DUCKDB DATABASE FUNCTIONS
// ════════════════════════════════════════════════════════════════

async function loadGTFSFile(filePath) {
  const startTime = Date.now();
  
  try {
    console.log('[Main] Loading GTFS from:', filePath);
    
    const sendProgress = (step, percent) => {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('gtfs-load-progress', { step, percent });
      }
    };
    
    sendProgress('Validating file...', 2);
    const fingerprint = await computeFingerprint(filePath);
    const cacheKey = `gtfs-${fingerprint}`;
    const cacheDbPath = path.join(CACHE_DIR, `${cacheKey}.db`);
    const cacheMetaPath = path.join(CACHE_DIR, `${cacheKey}.meta.json`);
    
    // Check cache
    if (fs.existsSync(cacheDbPath) && fs.existsSync(cacheMetaPath)) {
      const meta = JSON.parse(fs.readFileSync(cacheMetaPath));
      const stats = fs.statSync(filePath);
      
      const fileUnchanged = 
        meta.sourceSize === stats.size &&
        meta.sourceMtime === stats.mtime.toISOString() &&
        meta.sourceHash === fingerprint;
      
      if (fileUnchanged) {
        console.log('[Cache] HIT - loading from cache');
        sendProgress('Loading from cache...', 50);
        
        if (db) await new Promise((resolve) => db.close(resolve));
        
        db = await new Promise((resolve, reject) => {
          const database = new duckdb.Database(cacheDbPath, duckdb.OPEN_READONLY, (err) => {
            if (err) reject(err);
            else resolve(database);
          });
        });
        
        sendProgress('Complete!', 100);
        const duration = Date.now() - startTime;
        
        return { 
          success: true, 
          fromCache: true, 
          stats: meta.stats,
          loadTime: duration
        };
      } else {
        console.log('[Cache] STALE - rebuilding');
        try {
          fs.unlinkSync(cacheDbPath);
          fs.unlinkSync(cacheMetaPath);
        } catch (err) {
          console.warn('[Cache] Error removing stale cache:', err);
        }
      }
    }
    
    console.log('[Cache] MISS - building new database');
    return await buildDatabaseFromZip(filePath, cacheDbPath, cacheMetaPath, fingerprint, sendProgress);
    
  } catch (error) {
    console.error('[Main] Error loading GTFS:', error);
    throw error;
  }
}

async function buildDatabaseFromZip(zipPath, dbPath, metaPath, hash, sendProgress) {
  const startTime = Date.now();
  const tmpDir = path.join(os.tmpdir(), `gtfs-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  
  try {
    sendProgress('Extracting archive...', 5);
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(tmpDir, true);
    
    sendProgress('Creating database...', 10);
    
    // Close existing database connection if any
    if (db) await new Promise((resolve) => db.close(resolve));
    
    // Remove database file if it exists (from partial/failed previous load)
    if (fs.existsSync(dbPath)) {
      try {
        fs.unlinkSync(dbPath);
        console.log('[DB] Removed existing database file');
      } catch (err) {
        console.warn('[DB] Could not remove existing database file:', err);
      }
    }
    
    db = await new Promise((resolve, reject) => {
      const database = new duckdb.Database(dbPath, (err) => {
        if (err) reject(err);
        else resolve(database);
      });
    });
    
    const conn = db.connect();
    const execAsync = (sql) => new Promise((resolve, reject) => {
      conn.exec(sql, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    const tables = [
      { name: 'agency', required: false, progress: 15 },
      { name: 'routes', required: true, progress: 20 },
      { name: 'trips', required: true, progress: 30 },
      { name: 'stops', required: true, progress: 40 },
      { name: 'stop_times', required: true, progress: 70 },
      { name: 'calendar', required: false, progress: 75 },
      { name: 'calendar_dates', required: false, progress: 80 },
      { name: 'shapes', required: false, progress: 90 }
    ];
    
    for (const { name, required, progress } of tables) {
      const csvPath = path.join(tmpDir, `${name}.txt`);
      
      if (!fs.existsSync(csvPath)) {
        if (required) throw new Error(`Missing required file: ${name}.txt`);
        console.warn(`[DB] Skipping ${name}.txt`);
        continue;
      }
      
      const fileSizeMB = fs.statSync(csvPath).size / (1024 * 1024);
      sendProgress(`Loading ${name}.txt (${fileSizeMB.toFixed(1)}MB)...`, progress);
      
      const normalizedPath = csvPath.replace(/\\/g, '/');
      await execAsync(`
        CREATE TABLE ${name} AS 
        SELECT * FROM read_csv_auto('${normalizedPath}',
          header=true,
          ignore_errors=true,
          nullstr='',
          delim=',',
          quote='"',
          sample_size=100000,
          all_varchar=true
        )
      `);
      
      console.log(`[DB] ✓ Loaded ${name}`);
    }
    
    sendProgress('Building indexes...', 92);
    await execAsync(`
      CREATE INDEX IF NOT EXISTS idx_trips_route ON trips(route_id);
      CREATE INDEX IF NOT EXISTS idx_trips_service ON trips(service_id);
      CREATE INDEX IF NOT EXISTS idx_stop_times_trip ON stop_times(trip_id);
      CREATE INDEX IF NOT EXISTS idx_stop_times_trip_seq ON stop_times(trip_id, stop_sequence);
      CREATE INDEX IF NOT EXISTS idx_calendar_service ON calendar(service_id);
      CREATE INDEX IF NOT EXISTS idx_calendar_dates_date ON calendar_dates(date);
    `);
    
    await execAsync('VACUUM');
    
    sendProgress('Collecting statistics...', 95);
    const allAsync = (sql) => new Promise((resolve, reject) => {
      conn.all(sql, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
    
    const stats = {};
    try {
      stats.routes = Number((await allAsync('SELECT COUNT(*) as cnt FROM routes'))[0].cnt);
      stats.trips = Number((await allAsync('SELECT COUNT(*) as cnt FROM trips'))[0].cnt);
      stats.stops = Number((await allAsync('SELECT COUNT(*) as cnt FROM stops'))[0].cnt);
      stats.stopTimes = Number((await allAsync('SELECT COUNT(*) as cnt FROM stop_times'))[0].cnt);
    } catch (err) {
      console.warn('[DB] Error collecting stats:', err);
      stats.routes = stats.trips = stats.stops = stats.stopTimes = 0;
    }
    
    const meta = {
      sourceFile: zipPath,
      sourceHash: hash,
      sourceSize: fs.statSync(zipPath).size,
      sourceMtime: fs.statSync(zipPath).mtime.toISOString(),
      createdAt: new Date().toISOString(),
      stats
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    
    sendProgress('Database loaded, preparing UI...', 95);
    
    console.log(`[DB] Built in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    return { success: true, fromCache: false, stats };
    
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      console.warn('[Cleanup] Error:', err);
    }
  }
}

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
    const result = await loadGTFSFile(filePath);
    return result;
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

// Helper function to convert BigInt values to Numbers and handle non-serializable types for IPC
function convertBigIntsToNumbers(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'bigint') return Number(obj);
  if (typeof obj === 'function') return undefined;
  if (typeof obj === 'symbol') return undefined;
  
  if (Array.isArray(obj)) return obj.map(convertBigIntsToNumbers);
  
  if (typeof obj === 'object') {
    // Handle special object types
    if (obj instanceof Date) return obj.toISOString();
    if (obj instanceof Buffer) return obj.toString('utf8');
    
    const result = {};
    for (const key in obj) {
      const value = obj[key];
      // Skip non-serializable values
      if (typeof value === 'function' || typeof value === 'symbol') continue;
      result[key] = convertBigIntsToNumbers(value);
    }
    return result;
  }
  
  return obj;
}

ipcMain.handle('query-routes', async () => {
  if (!db) throw new Error('Database not loaded');
  
  const conn = db.connect();
  
  try {
    console.log('[SQL] query-routes START');
    
    // Get columns with timeout
    const columns = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout getting columns')), 10000);
      conn.all(`SELECT column_name FROM information_schema.columns WHERE table_name = 'routes'`, 
        (err, rows) => {
          clearTimeout(timeout);
          err ? reject(err) : resolve(rows);
        });
    });
    
    const columnSet = new Set(columns.map(c => c.column_name.toLowerCase()));
    
    // Build SELECT clause with only existing columns
    const selectClauses = ['r.route_id'];
    
    // Required columns (should always exist)
    if (columnSet.has('route_short_name')) selectClauses.push('ANY_VALUE(r.route_short_name) as route_short_name');
    if (columnSet.has('route_long_name')) selectClauses.push('ANY_VALUE(r.route_long_name) as route_long_name');
    if (columnSet.has('route_type')) selectClauses.push('ANY_VALUE(r.route_type) as route_type');
    
    // Optional columns
    if (columnSet.has('agency_id')) selectClauses.push('ANY_VALUE(r.agency_id) as agency_id');
    if (columnSet.has('route_desc')) selectClauses.push('ANY_VALUE(r.route_desc) as route_desc');
    if (columnSet.has('route_url')) selectClauses.push('ANY_VALUE(r.route_url) as route_url');
    if (columnSet.has('route_color')) selectClauses.push('ANY_VALUE(r.route_color) as route_color');
    if (columnSet.has('route_text_color')) selectClauses.push('ANY_VALUE(r.route_text_color) as route_text_color');
    
    selectClauses.push('COALESCE(ANY_VALUE(a.agency_name), \'Unknown\') as agency_name');
    selectClauses.push('COUNT(DISTINCT t.trip_id) as trip_count');
    
    const query = `
      SELECT ${selectClauses.join(', ')}
      FROM routes r
      LEFT JOIN agency a ON r.agency_id = a.agency_id
      LEFT JOIN trips t ON r.route_id = t.route_id
      GROUP BY r.route_id
      ORDER BY ANY_VALUE(r.route_short_name)
    `;
    
    // Execute main query with timeout
    const rows = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout')), 10000);
      conn.all(query, (err, rows) => {
        clearTimeout(timeout);
        err ? reject(err) : resolve(rows);
      });
    });
    
    console.log('[SQL] query-routes SUCCESS:', rows.length, 'rows');
    return convertBigIntsToNumbers(rows || []);
    
  } catch (err) {
    console.error('[SQL] query-routes FAILED:', err);
    throw err;
  } finally {
    conn.close();
  }
});

ipcMain.handle('query-trips', async (event, { routeId, date, directionId }) => {
  if (!db) throw new Error('Database not loaded');
  
  const conn = db.connect();
  
  try {
    console.log('[SQL] query-trips START');
    
    const dateObj = new Date(
      parseInt(date.substring(0, 4)),
      parseInt(date.substring(4, 6)) - 1,
      parseInt(date.substring(6, 8))
    );
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayColumn = dayNames[dateObj.getDay()];
    
    // Get columns with timeout
    const columns = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout getting columns')), 10000);
      conn.all(`SELECT column_name FROM information_schema.columns WHERE table_name = 'trips'`, 
        (err, rows) => {
          clearTimeout(timeout);
          err ? reject(err) : resolve(rows);
        });
    });
    
    const columnSet = new Set(columns.map(c => c.column_name.toLowerCase()));
    
    // Build SELECT clause with only existing columns
    const selectClauses = [];
    
    // Required columns
    if (columnSet.has('route_id')) selectClauses.push('t.route_id');
    if (columnSet.has('service_id')) selectClauses.push('t.service_id');
    if (columnSet.has('trip_id')) selectClauses.push('t.trip_id');
    
    // Optional columns
    if (columnSet.has('trip_headsign')) selectClauses.push('t.trip_headsign');
    if (columnSet.has('trip_short_name')) selectClauses.push('t.trip_short_name');
    if (columnSet.has('direction_id')) selectClauses.push('t.direction_id');
    if (columnSet.has('block_id')) selectClauses.push('t.block_id');
    if (columnSet.has('shape_id')) selectClauses.push('t.shape_id');
    if (columnSet.has('wheelchair_accessible')) selectClauses.push('t.wheelchair_accessible');
    if (columnSet.has('bikes_allowed')) selectClauses.push('t.bikes_allowed');
    
    selectClauses.push('(SELECT departure_time FROM stop_times WHERE trip_id = t.trip_id ORDER BY CAST(stop_sequence AS INTEGER) ASC LIMIT 1) as first_departure');
    
    const query = `
      WITH active_services AS (
        SELECT service_id FROM calendar
        WHERE start_date <= ? AND end_date >= ? AND ${dayColumn} = '1'
        UNION
        SELECT service_id FROM calendar_dates WHERE date = ? AND exception_type = '1'
        EXCEPT
        SELECT service_id FROM calendar_dates WHERE date = ? AND exception_type = '2'
      )
      SELECT ${selectClauses.join(', ')}
      FROM trips t
      WHERE t.route_id = ? AND t.direction_id = ? AND t.service_id IN (SELECT service_id FROM active_services)
      ORDER BY first_departure
    `;
    
    // Execute main query with timeout
    const rows = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout')), 10000);
      conn.all(query, [date, date, date, date, routeId, directionId], (err, rows) => {
        clearTimeout(timeout);
        err ? reject(err) : resolve(rows);
      });
    });
    
    console.log('[SQL] query-trips SUCCESS:', rows.length, 'rows');
    return convertBigIntsToNumbers(rows || []);
    
  } catch (err) {
    console.error('[SQL] query-trips FAILED:', err);
    throw err;
  } finally {
    conn.close();
  }
});

ipcMain.handle('query-stop-times', async (event, tripId) => {
  if (!db) throw new Error('Database not loaded');
  
  const conn = db.connect();
  
  try {
    console.log('[SQL] query-stop-times START');
    
    // Get columns with timeout
    const columns = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout getting columns')), 10000);
      conn.all(`SELECT column_name FROM information_schema.columns WHERE table_name = 'stop_times'`, 
        (err, rows) => {
          clearTimeout(timeout);
          err ? reject(err) : resolve(rows);
        });
    });
    
    const columnSet = new Set(columns.map(c => c.column_name.toLowerCase()));
    
    // Build SELECT clause with only existing columns
    const selectClauses = [];
    
    // Required columns
    if (columnSet.has('trip_id')) selectClauses.push('st.trip_id');
    if (columnSet.has('arrival_time')) selectClauses.push('st.arrival_time');
    if (columnSet.has('departure_time')) selectClauses.push('st.departure_time');
    if (columnSet.has('stop_id')) selectClauses.push('st.stop_id');
    if (columnSet.has('stop_sequence')) selectClauses.push('st.stop_sequence');
    
    // Optional columns
    if (columnSet.has('stop_headsign')) selectClauses.push('st.stop_headsign');
    if (columnSet.has('pickup_type')) selectClauses.push('st.pickup_type');
    if (columnSet.has('drop_off_type')) selectClauses.push('st.drop_off_type');
    if (columnSet.has('shape_dist_traveled')) selectClauses.push('st.shape_dist_traveled');
    if (columnSet.has('timepoint')) selectClauses.push('st.timepoint');
    
    // Add stop info
    selectClauses.push('s.stop_name', 's.stop_lat', 's.stop_lon');
    
    const query = `
      SELECT ${selectClauses.join(', ')}
      FROM stop_times st
      JOIN stops s ON st.stop_id = s.stop_id
      WHERE st.trip_id = ?
      ORDER BY CAST(st.stop_sequence AS INTEGER)
    `;
    
    // Execute query with timeout
    const rows = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout')), 10000);
      conn.all(query, [tripId], (err, rows) => {
        clearTimeout(timeout);
        err ? reject(err) : resolve(rows);
      });
    });
    
    console.log('[SQL] query-stop-times SUCCESS:', rows.length, 'rows');
    return convertBigIntsToNumbers(rows || []);
    
  } catch (err) {
    console.error('[SQL] query-stop-times FAILED:', err);
    throw err;
  } finally {
    conn.close();
  }
});

ipcMain.handle('query-shape', async (event, shapeId) => {
  if (!db) throw new Error('Database not loaded');
  
  const conn = db.connect();
  
  try {
    console.log('[SQL] query-shape START');
    
    const rows = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout')), 10000);
      conn.all(`
        SELECT shape_pt_lat, shape_pt_lon FROM shapes WHERE shape_id = ? ORDER BY CAST(shape_pt_sequence AS INTEGER)
      `, [shapeId], (err, rows) => {
        clearTimeout(timeout);
        err ? reject(err) : resolve(rows);
      });
    });
    
    console.log('[SQL] query-shape SUCCESS:', rows.length, 'points');
    const converted = convertBigIntsToNumbers(rows || []);
    return converted.map(r => [r.shape_pt_lat, r.shape_pt_lon]);
    
  } catch (err) {
    console.error('[SQL] query-shape FAILED:', err);
    throw err;
  } finally {
    conn.close();
  }
});

ipcMain.handle('query-available-dates', async () => {
  if (!db) throw new Error('Database not loaded');
  
  const conn = db.connect();
  
  try {
    console.log('[SQL] query-available-dates START');
    
    const rows = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout')), 10000);
      conn.all(`SELECT DISTINCT start_date, end_date FROM calendar ORDER BY start_date`, 
        (err, rows) => {
          clearTimeout(timeout);
          err ? reject(err) : resolve(rows);
        });
    });
    
    console.log('[SQL] query-available-dates SUCCESS:', rows.length, 'ranges');
    return convertBigIntsToNumbers(rows || []);
    
  } catch (err) {
    console.error('[SQL] query-available-dates FAILED:', err);
    throw err;
  } finally {
    conn.close();
  }
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

app.on('quit', async () => {
  if (db) await new Promise((resolve) => db.close(resolve));
});