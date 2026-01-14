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
    
    // Check if parent_station column exists before creating index
    let hasParentStation = false;
    try {
      const columnCheck = await allAsync("PRAGMA table_info(stops)");
      hasParentStation = columnCheck.some(col => col.name === 'parent_station');
      console.log('[DB] parent_station column exists:', hasParentStation);
    } catch (err) {
      console.warn('[DB] Could not check for parent_station column:', err);
    }
    
    // Create indexes conditionally
    const parentStationIndex = hasParentStation 
      ? 'CREATE INDEX IF NOT EXISTS idx_stops_parent ON stops(parent_station);' 
      : '';
    
    await execAsync(`
      CREATE INDEX IF NOT EXISTS idx_trips_route ON trips(route_id);
      CREATE INDEX IF NOT EXISTS idx_trips_service ON trips(service_id);
      CREATE INDEX IF NOT EXISTS idx_stop_times_trip ON stop_times(trip_id);
      CREATE INDEX IF NOT EXISTS idx_stop_times_trip_seq ON stop_times(trip_id, stop_sequence);
      CREATE INDEX IF NOT EXISTS idx_stop_times_stop ON stop_times(stop_id);
      CREATE INDEX IF NOT EXISTS idx_calendar_service ON calendar(service_id);
      CREATE INDEX IF NOT EXISTS idx_calendar_dates_date ON calendar_dates(date);
      CREATE INDEX IF NOT EXISTS idx_stops_name ON stops(stop_name);
      ${parentStationIndex}
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

    // 1. Pobierz kolumny:
    const columns = await new Promise((resolve, reject) => {
      conn.all(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'routes'`,
        (err, rows) => err ? reject(err) : resolve(rows)
      );
    });
    const columnSet = new Set(columns.map(c => c.column_name.toLowerCase()));

    // 2. Zbuduj SELECT dynamicznie:
const select = [
  'r.route_id',
  columnSet.has('route_short_name') && 'ANY_VALUE(r.route_short_name) as route_short_name',
  columnSet.has('route_long_name') && 'ANY_VALUE(r.route_long_name) as route_long_name',
  columnSet.has('route_type') && 'ANY_VALUE(r.route_type) as route_type',
  columnSet.has('agency_id') && 'ANY_VALUE(r.agency_id) as agency_id',
  "COUNT(DISTINCT t.trip_id) as trip_count"
].filter(Boolean);

const joinAgency =
  columnSet.has('agency_id')
    ? 'LEFT JOIN agency a ON r.agency_id = a.agency_id'
    : '';

const agencyNameSelect =
  columnSet.has('agency_id')
    ? "COALESCE(ANY_VALUE(a.agency_name), 'Unknown') as agency_name"
    : "'Unknown' as agency_name";

const sql = `
  SELECT ${select.join(', ')}, ${agencyNameSelect}
  FROM routes r
  ${joinAgency}
  LEFT JOIN trips t ON r.route_id = t.route_id
  GROUP BY r.route_id
  ORDER BY ${columnSet.has('route_short_name') ? 'route_short_name' : 'r.route_id'}
`;

    // 4. Wykonaj query
    const rows = await new Promise((resolve, reject) => {
      conn.all(sql, (err, rows) => err ? reject(err) : resolve(rows));
    });

    return convertBigIntsToNumbers(rows || []);
  } catch (err) {
    console.error('[SQL] query-routes FAILED:', err);
    throw err;
  } finally {
    conn.close();
    console.log('[SQL] query-routes connection closed');
  }
});
    
ipcMain.handle('query-trips', async (event, { routeId, date, directionId }) => {
  console.log('🔍 [SQL] query-trips CALLED with:', JSON.stringify({ routeId, date, directionId }));
  
  if (!db) throw new Error('Database not loaded');
  
  const conn = db.connect();
  
  try {
    // Walidacja
    if (!routeId) {
      throw new Error('❌ routeId is missing!   Got:   ' + routeId);
    }
    
    if (!date || date.length !== 8) {
      throw new Error('❌ date is invalid!  Got:  ' + date);
    }
    
    const direction = String(directionId ??   '0');
    console.log('✅ Validated params:', { routeId, date, direction });
    
    const dateObj = new Date(
      parseInt(date.substring(0, 4)),
      parseInt(date. substring(4, 6)) - 1,
      parseInt(date.substring(6, 8))
    );
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayColumn = dayNames[dateObj.getDay()];
    
    // Check which tables exist
    const tables = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout getting tables')), 10000);
      conn.all(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'`, 
        (err, rows) => {
          clearTimeout(timeout);
          if (err) reject(err);
          else resolve(rows);
        });
    });
    
    const tableSet = new Set(tables. map(t => t.table_name. toLowerCase()));
    const hasCalendar = tableSet.has('calendar');
    const hasCalendarDates = tableSet.has('calendar_dates');
    
    console.log('[SQL] Tables - calendar:', hasCalendar, 'calendar_dates:', hasCalendarDates);
    
    // Get columns
    const columns = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout getting columns')), 10000);
      conn.all(`SELECT column_name FROM information_schema. columns WHERE table_name = 'trips'`, 
        (err, rows) => {
          clearTimeout(timeout);
          if (err) reject(err);
          else resolve(rows);
        });
    });
    
    const columnSet = new Set(columns.map(c => c.column_name.toLowerCase()));
    
    // Build SELECT clause
    const selectClauses = [];
    
    if (columnSet.has('route_id')) selectClauses.push('t. route_id');
    if (columnSet.has('service_id')) selectClauses.push('t.service_id');
    if (columnSet.has('trip_id')) selectClauses.push('t.trip_id');
    if (columnSet.has('trip_headsign')) selectClauses.push('t.trip_headsign');
    if (columnSet.has('trip_short_name')) selectClauses.push('t.trip_short_name');
    if (columnSet.has('direction_id')) selectClauses.push('t.direction_id');
    if (columnSet.has('block_id')) selectClauses.push('t.block_id');
    if (columnSet.has('shape_id')) selectClauses.push('t.shape_id');
    if (columnSet.has('wheelchair_accessible')) selectClauses.push('t.wheelchair_accessible');
    if (columnSet.has('bikes_allowed')) selectClauses.push('t. bikes_allowed');
    
    selectClauses.push('(SELECT departure_time FROM stop_times WHERE trip_id = t.trip_id ORDER BY CAST(stop_sequence AS INTEGER) ASC LIMIT 1) as first_departure');
    
    // Build query based on available tables
    let query;
    let params;
    
    if (hasCalendar && hasCalendarDates) {
      query = `
        WITH active_services AS (
          SELECT service_id FROM calendar
          WHERE start_date <= $1 AND end_date >= $2 AND ${dayColumn} = '1'
          UNION
          SELECT service_id FROM calendar_dates WHERE date = $3 AND exception_type = '1'
          EXCEPT
          SELECT service_id FROM calendar_dates WHERE date = $4 AND exception_type = '2'
        )
        SELECT ${selectClauses. join(', ')}
        FROM trips t
        WHERE t.route_id = $5 AND t.direction_id = $6 AND t.service_id IN (SELECT service_id FROM active_services)
        ORDER BY first_departure
      `;
      params = [date, date, date, date, routeId, direction];
      
    } else if (hasCalendar) {
      query = `
        WITH active_services AS (
          SELECT service_id FROM calendar
          WHERE start_date <= $1 AND end_date >= $2 AND ${dayColumn} = '1'
        )
        SELECT ${selectClauses.join(', ')}
        FROM trips t
        WHERE t. route_id = $3 AND t.direction_id = $4 AND t.service_id IN (SELECT service_id FROM active_services)
        ORDER BY first_departure
      `;
      params = [date, date, routeId, direction];
      
    } else {
      query = `
        SELECT ${selectClauses.join(', ')}
        FROM trips t
        WHERE t. route_id = $1 AND t.direction_id = $2 
        ORDER BY first_departure
      `;
      params = [routeId, direction];
    }
    
    console. log('[SQL] Query params:', params);
    console.log('🚀 About to execute query with params:', params);
    console.log('📝 Query:', query.substring(0, 200) + '...');
    
    // ✅ JEDNO wywołanie conn.all z spread operatorem
    const rows = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout')), 30000);
      conn.all(query, ...params, (err, rows) => {  // ✅ ... params (spread operator)
        clearTimeout(timeout);
        if (err) {
          console.error('❌ [SQL] Query error:', err);
          console.error('📝 Failed query:', query);
          console.error('🔢 Failed params:', params);
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
    
    console.log('✅ [SQL] query-trips SUCCESS:', rows.length, 'rows');
    
    conn.close();
    return convertBigIntsToNumbers(rows);
    
  } catch (error) {
    console.error('❌ [SQL] query-trips ERROR:', error);
    try {
      conn.close();
    } catch (e) {}
    throw error;
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

// Bulk query for route data - loads trips with embedded stop_times in one query
ipcMain.handle('query-route-data-bulk', async (event, { routeId, date, directionId }) => {
  if (!db) throw new Error('Database not loaded');
  
  const conn = db.connect();
  
  try {
    console.log('[SQL] query-route-data-bulk START', { routeId, date, directionId });
    
    // Check which tables exist
    const tables = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout getting tables')), 10000);
      conn.all(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'`, 
        (err, rows) => {
          clearTimeout(timeout);
          if (err) reject(err);
          else resolve(rows);
        });
    });
    
    const tableSet = new Set(tables.map(t => t.table_name.toLowerCase()));
    const hasCalendar = tableSet.has('calendar');
    const hasCalendarDates = tableSet.has('calendar_dates');
    const hasShapes = tableSet.has('shapes');
    
    // Parse date for day of week
    const dateObj = new Date(
      parseInt(date.substring(0, 4)),
      parseInt(date.substring(4, 6)) - 1,
      parseInt(date.substring(6, 8))
    );
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayColumn = dayNames[dateObj.getDay()];
    
    // Build active_services CTE based on available tables
    let activeServicesCTE;
    let params;
    
    if (hasCalendar && hasCalendarDates) {
      activeServicesCTE = `
        WITH active_services AS (
          SELECT service_id FROM calendar
          WHERE start_date <= $1 AND end_date >= $2 AND ${dayColumn} = '1'
          UNION
          SELECT service_id FROM calendar_dates WHERE date = $3 AND exception_type = '1'
          EXCEPT
          SELECT service_id FROM calendar_dates WHERE date = $4 AND exception_type = '2'
        )`;
      params = [date, date, date, date, routeId, directionId];
    } else if (hasCalendar) {
      activeServicesCTE = `
        WITH active_services AS (
          SELECT service_id FROM calendar
          WHERE start_date <= $1 AND end_date >= $2 AND ${dayColumn} = '1'
        )`;
      params = [date, date, routeId, directionId];
    } else {
      activeServicesCTE = 'WITH active_services AS (SELECT DISTINCT service_id FROM trips)';
      params = [routeId, directionId];
    }
    
    // Get trips columns dynamically
    const tripsCols = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout getting columns')), 10000);
      conn.all(`SELECT column_name FROM information_schema.columns WHERE table_name = 'trips'`, 
        (err, rows) => {
          clearTimeout(timeout);
          err ? reject(err) : resolve(rows);
        });
    });
    const tripsColSet = new Set(tripsCols.map(c => c.column_name.toLowerCase()));
    
    // Build trips SELECT dynamically
    const tripsSelect = ['t.route_id', 't.service_id', 't.trip_id'];
    if (tripsColSet.has('trip_headsign')) tripsSelect.push('t.trip_headsign');
    if (tripsColSet.has('trip_short_name')) tripsSelect.push('t.trip_short_name');
    if (tripsColSet.has('direction_id')) tripsSelect.push('t.direction_id');
    if (tripsColSet.has('block_id')) tripsSelect.push('t.block_id');
    if (tripsColSet.has('shape_id')) tripsSelect.push('t.shape_id');
    if (tripsColSet.has('wheelchair_accessible')) tripsSelect.push('t.wheelchair_accessible');
    if (tripsColSet.has('bikes_allowed')) tripsSelect.push('t.bikes_allowed');
    
    // Main bulk query - returns trips with embedded stop_times as JSON
    const query = `
      ${activeServicesCTE},
      route_trips AS (
        SELECT ${tripsSelect.join(', ')}
        FROM trips t
        WHERE t.route_id = $${params.length - 1}
          AND t.direction_id = $${params.length}
          AND t.service_id IN (SELECT service_id FROM active_services)
      )
      SELECT 
        t.*,
        (
          SELECT JSON_GROUP_ARRAY(
            JSON_OBJECT(
              'trip_id', st.trip_id,
              'stop_id', st.stop_id,
              'stop_sequence', st.stop_sequence,
              'arrival_time', st.arrival_time,
              'departure_time', st.departure_time,
              'pickup_type', COALESCE(st.pickup_type, '0'),
              'drop_off_type', COALESCE(st.drop_off_type, '0'),
              'stop_name', s.stop_name,
              'stop_lat', s.stop_lat,
              'stop_lon', s.stop_lon
            )
          )
          FROM (
            SELECT st.*, s.stop_name, s.stop_lat, s.stop_lon
            FROM stop_times st
            JOIN stops s ON st.stop_id = s.stop_id
            WHERE st.trip_id = t.trip_id
            ORDER BY CAST(st.stop_sequence AS INTEGER)
          ) st
        ) as stop_times_json,
        (
          SELECT departure_time 
          FROM stop_times 
          WHERE trip_id = t.trip_id 
          ORDER BY CAST(stop_sequence AS INTEGER) ASC 
          LIMIT 1
        ) as first_departure
      FROM route_trips t
      ORDER BY first_departure
    `;
    
    console.log('[SQL] Executing bulk query with', params.length, 'params');
    
    const rows = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout')), 60000); // 60s for large routes
      conn.all(query, ...params, (err, rows) => {
        clearTimeout(timeout);
        if (err) {
          console.error('[SQL] Bulk query error:', err);
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
    
    console.log('[SQL] query-route-data-bulk SUCCESS:', rows.length, 'trips');
    
    // Parse JSON for each trip and replace with parsed stop_times array
    const tripsWithParsedStopTimes = rows.map(row => {
      const { stop_times_json, ...tripData } = row;
      return {
        ...tripData,
        stop_times: stop_times_json ? JSON.parse(stop_times_json) : []
      };
    });
    
    return convertBigIntsToNumbers(tripsWithParsedStopTimes);
    
  } catch (err) {
    console.error('[SQL] query-route-data-bulk FAILED:', err);
    throw err;
  } finally {
    conn.close();
  }
});

ipcMain.handle('query-available-dates', async () => {
  if (!db) throw new Error('Database not loaded');
  
  const conn = db.connect();
  
  try {
    console. log('[SQL] query-available-dates START');
    
    const rows = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.error('[SQL] query-available-dates TIMEOUT');
        reject(new Error('Query timeout'));
      }, 10000);
      
      conn.all(`SELECT DISTINCT start_date, end_date FROM calendar ORDER BY start_date`, 
        (err, rows) => {
          clearTimeout(timeout);
          if (err) {
            console.error('[SQL] query-available-dates ERROR:', err);
            reject(err);
          } else {
            console.log('[SQL] query-available-dates SUCCESS:', rows.length, 'rows');
            resolve(rows);
          }
        });
    });
    
    return convertBigIntsToNumbers(rows || []);
    
  } catch (err) {
    console.error('[SQL] query-available-dates FAILED:', err);
    throw err;
  } finally {
    conn.close();
    console.log('[SQL] query-available-dates connection closed');
  }
});

// Query departures for a stop on a specific date
ipcMain.handle('query-departures-for-stop', async (event, { stopId, date }) => {
  if (!db) throw new Error('Database not loaded');
  
  const conn = db.connect();
  
  try {
    console.log('[SQL] query-departures-for-stop START', { stopId, date });
    
    if (!stopId) {
      throw new Error('stopId is required');
    }
    
    if (!date || date.length !== 8) {
      throw new Error('date must be in YYYYMMDD format');
    }
    
    // Check which tables exist
    const tables = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout getting tables')), 10000);
      conn.all(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'`, 
        (err, rows) => {
          clearTimeout(timeout);
          if (err) reject(err);
          else resolve(rows);
        });
    });
    
    const tableSet = new Set(tables.map(t => t.table_name.toLowerCase()));
    const hasCalendar = tableSet.has('calendar');
    const hasCalendarDates = tableSet.has('calendar_dates');
    
    // Parse date for day of week
    const dateObj = new Date(
      parseInt(date.substring(0, 4)),
      parseInt(date.substring(4, 6)) - 1,
      parseInt(date.substring(6, 8))
    );
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayColumn = dayNames[dateObj.getDay()];
    
    // Build query based on available tables
    let query;
    let params;
    
    if (hasCalendar && hasCalendarDates) {
      query = `
        WITH active_services AS (
          SELECT service_id FROM calendar
          WHERE start_date <= $1 AND end_date >= $2 AND ${dayColumn} = '1'
          UNION
          SELECT service_id FROM calendar_dates WHERE date = $3 AND exception_type = '1'
          EXCEPT
          SELECT service_id FROM calendar_dates WHERE date = $4 AND exception_type = '2'
        )
        SELECT 
          t.trip_id,
          st.departure_time,
          t.trip_headsign,
          r.route_short_name,
          r.route_long_name,
          r.route_type,
          r.route_id,
          t.direction_id,
          t.service_id
        FROM stop_times st
        JOIN trips t ON st.trip_id = t.trip_id
        JOIN routes r ON t.route_id = r.route_id
        WHERE st.stop_id = $5 
          AND t.service_id IN (SELECT service_id FROM active_services)
        ORDER BY st.departure_time
      `;
      params = [date, date, date, date, stopId];
      
    } else if (hasCalendar) {
      query = `
        WITH active_services AS (
          SELECT service_id FROM calendar
          WHERE start_date <= $1 AND end_date >= $2 AND ${dayColumn} = '1'
        )
        SELECT 
          t.trip_id,
          st.departure_time,
          t.trip_headsign,
          r.route_short_name,
          r.route_long_name,
          r.route_type,
          r.route_id,
          t.direction_id,
          t.service_id
        FROM stop_times st
        JOIN trips t ON st.trip_id = t.trip_id
        JOIN routes r ON t.route_id = r.route_id
        WHERE st.stop_id = $3
          AND t.service_id IN (SELECT service_id FROM active_services)
        ORDER BY st.departure_time
      `;
      params = [date, date, stopId];
      
    } else {
      // No calendar tables - return all departures at this stop
      query = `
        SELECT 
          t.trip_id,
          st.departure_time,
          t.trip_headsign,
          r.route_short_name,
          r.route_long_name,
          r.route_type,
          r.route_id,
          t.direction_id,
          t.service_id
        FROM stop_times st
        JOIN trips t ON st.trip_id = t.trip_id
        JOIN routes r ON t.route_id = r.route_id
        WHERE st.stop_id = $1
        ORDER BY st.departure_time
      `;
      params = [stopId];
    }
    
    const rows = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout')), 30000);
      conn.all(query, ...params, (err, rows) => {
        clearTimeout(timeout);
        if (err) {
          console.error('[SQL] query-departures-for-stop ERROR:', err);
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
    
    console.log('[SQL] query-departures-for-stop SUCCESS:', rows.length, 'departures');
    return convertBigIntsToNumbers(rows || []);
    
  } catch (err) {
    console.error('[SQL] query-departures-for-stop FAILED:', err);
    throw err;
  } finally {
    conn.close();
  }
});

// Query distinct directions for a route with detailed information
ipcMain.handle('query-directions-for-route', async (event, routeIds) => {
  if (!db) throw new Error('Database not loaded');
  
  const conn = db.connect();
  
  try {
    console.log('[SQL] query-directions-for-route START', { routeIds });
    
    // Support both single routeId and array of routeIds
    const routeIdArray = Array.isArray(routeIds) ? routeIds : [routeIds];
    
    if (!routeIdArray.length) {
      throw new Error('routeId(s) required');
    }
    
    // Build placeholders for SQL IN clause
    const placeholders = routeIdArray.map(() => '?').join(',');
    
    // Query to get direction information with terminal stop details
    // This gets the most common final stop for each direction
    const query = `
      WITH trip_terminals AS (
        SELECT 
          t.route_id,
          t.direction_id,
          t.trip_id,
          t.trip_headsign,
          last_st.stop_id as terminal_stop_id,
          s.stop_name as terminal_stop_name
        FROM trips t
        JOIN (
          SELECT 
            trip_id,
            stop_id,
            stop_sequence
          FROM stop_times st1
          WHERE stop_sequence = (
            SELECT MAX(CAST(stop_sequence AS INTEGER))
            FROM stop_times st2
            WHERE st2.trip_id = st1.trip_id
          )
        ) last_st ON t.trip_id = last_st.trip_id
        LEFT JOIN stops s ON last_st.stop_id = s.stop_id
        WHERE t.route_id IN (${placeholders})
      ),
      direction_stats AS (
        SELECT 
          direction_id,
          terminal_stop_name,
          COUNT(*) as trip_count
        FROM trip_terminals
        GROUP BY direction_id, terminal_stop_name
      ),
      top_terminals AS (
        SELECT 
          direction_id,
          terminal_stop_name,
          trip_count,
          ROW_NUMBER() OVER (PARTITION BY direction_id ORDER BY trip_count DESC) as rank
        FROM direction_stats
      )
      SELECT 
        tt.direction_id,
        COUNT(DISTINCT tt.trip_id) as total_trips,
        MAX(CASE WHEN t1.rank = 1 THEN t1.terminal_stop_name END) as top1_terminal,
        MAX(CASE WHEN t1.rank = 1 THEN t1.trip_count END) as top1_count,
        MAX(CASE WHEN t1.rank = 2 THEN t1.terminal_stop_name END) as top2_terminal,
        MAX(CASE WHEN t1.rank = 2 THEN t1.trip_count END) as top2_count,
        MAX(tt.trip_headsign) as sample_headsign
      FROM trip_terminals tt
      LEFT JOIN top_terminals t1 ON tt.direction_id = t1.direction_id AND t1.rank <= 2
      GROUP BY tt.direction_id
      ORDER BY tt.direction_id
    `;
    
    const rows = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout')), 30000);
      conn.all(query, ...routeIdArray, (err, rows) => {
        clearTimeout(timeout);
        if (err) {
          console.error('[SQL] query-directions-for-route ERROR:', err);
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
    
    console.log('[SQL] query-directions-for-route SUCCESS:', rows.length, 'directions');
    return convertBigIntsToNumbers(rows || []);
    
  } catch (err) {
    console.error('[SQL] query-directions-for-route FAILED:', err);
    throw err;
  } finally {
    conn.close();
  }
});

// Query routes serving a specific stop on a date
ipcMain.handle('query-routes-at-stop', async (event, { stopId, date }) => {
  if (!db) throw new Error('Database not loaded');
  
  const conn = db.connect();
  
  try {
    console.log('[SQL] query-routes-at-stop START', { stopId, date });
    
    if (!stopId) {
      throw new Error('stopId is required');
    }
    
    if (!date || date.length !== 8) {
      throw new Error('date must be in YYYYMMDD format');
    }
    
    // Check which tables exist
    const tables = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout getting tables')), 10000);
      conn.all(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'`, 
        (err, rows) => {
          clearTimeout(timeout);
          if (err) reject(err);
          else resolve(rows);
        });
    });
    
    const tableSet = new Set(tables.map(t => t.table_name.toLowerCase()));
    const hasCalendar = tableSet.has('calendar');
    const hasCalendarDates = tableSet.has('calendar_dates');
    
    // Parse date for day of week
    const dateObj = new Date(
      parseInt(date.substring(0, 4)),
      parseInt(date.substring(4, 6)) - 1,
      parseInt(date.substring(6, 8))
    );
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayColumn = dayNames[dateObj.getDay()];
    
    // Build query based on available tables
    let query;
    let params;
    
    if (hasCalendar && hasCalendarDates) {
      query = `
        WITH active_services AS (
          SELECT service_id FROM calendar
          WHERE start_date <= $1 AND end_date >= $2 AND ${dayColumn} = '1'
          UNION
          SELECT service_id FROM calendar_dates WHERE date = $3 AND exception_type = '1'
          EXCEPT
          SELECT service_id FROM calendar_dates WHERE date = $4 AND exception_type = '2'
        )
        SELECT DISTINCT 
          r.route_id,
          r.route_short_name,
          r.route_long_name,
          r.route_type,
          COUNT(DISTINCT t.trip_id) as trip_count
        FROM stop_times st
        JOIN trips t ON st.trip_id = t.trip_id
        JOIN routes r ON t.route_id = r.route_id
        WHERE st.stop_id = $5
          AND t.service_id IN (SELECT service_id FROM active_services)
        GROUP BY r.route_id, r.route_short_name, r.route_long_name, r.route_type
        ORDER BY r.route_short_name
      `;
      params = [date, date, date, date, stopId];
      
    } else if (hasCalendar) {
      query = `
        WITH active_services AS (
          SELECT service_id FROM calendar
          WHERE start_date <= $1 AND end_date >= $2 AND ${dayColumn} = '1'
        )
        SELECT DISTINCT 
          r.route_id,
          r.route_short_name,
          r.route_long_name,
          r.route_type,
          COUNT(DISTINCT t.trip_id) as trip_count
        FROM stop_times st
        JOIN trips t ON st.trip_id = t.trip_id
        JOIN routes r ON t.route_id = r.route_id
        WHERE st.stop_id = $3
          AND t.service_id IN (SELECT service_id FROM active_services)
        GROUP BY r.route_id, r.route_short_name, r.route_long_name, r.route_type
        ORDER BY r.route_short_name
      `;
      params = [date, date, stopId];
      
    } else {
      // No calendar tables - return all routes at this stop
      query = `
        SELECT DISTINCT 
          r.route_id,
          r.route_short_name,
          r.route_long_name,
          r.route_type,
          COUNT(DISTINCT t.trip_id) as trip_count
        FROM stop_times st
        JOIN trips t ON st.trip_id = t.trip_id
        JOIN routes r ON t.route_id = r.route_id
        WHERE st.stop_id = $1
        GROUP BY r.route_id, r.route_short_name, r.route_long_name, r.route_type
        ORDER BY r.route_short_name
      `;
      params = [stopId];
    }
    
    const rows = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout')), 30000);
      conn.all(query, ...params, (err, rows) => {
        clearTimeout(timeout);
        if (err) {
          console.error('[SQL] query-routes-at-stop ERROR:', err);
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
    
    console.log('[SQL] query-routes-at-stop SUCCESS:', rows.length, 'routes');
    return convertBigIntsToNumbers(rows || []);
    
  } catch (err) {
    console.error('[SQL] query-routes-at-stop FAILED:', err);
    throw err;
  } finally {
    conn.close();
  }
});

// Query all stops with their routes (no date filter)
ipcMain.handle('query-stops-with-routes', async () => {
  if (!db) throw new Error('Database not loaded');
  
  const conn = db.connect();
  
  try {
    console.log('[SQL] query-stops-with-routes START');
    
    // Check if parent_station column exists
    let hasParentStation = false;
    try {
      const columnCheck = await new Promise((resolve, reject) => {
        conn.all("PRAGMA table_info(stops)", (err, rows) => {
          err ? reject(err) : resolve(rows);
        });
      });
      hasParentStation = columnCheck.some(col => col.name === 'parent_station');
      console.log('[SQL] parent_station column exists:', hasParentStation);
    } catch (err) {
      console.warn('[SQL] Could not check for parent_station column:', err);
    }
    
    // Build query with conditional parent_station
    const parentStationSelect = hasParentStation ? 's.parent_station,' : '';
    const parentStationGroup = hasParentStation ? 's.parent_station, ' : '';
    
    const query = `
      SELECT 
        s.stop_id,
        s.stop_name,
        s.stop_lat,
        s.stop_lon,
        ${parentStationSelect}
        r.route_id,
        r.route_short_name,
        r.route_long_name,
        r.route_type
      FROM stops s
      LEFT JOIN stop_times st ON s.stop_id = st.stop_id
      LEFT JOIN trips t ON st.trip_id = t.trip_id
      LEFT JOIN routes r ON t.route_id = r.route_id
      GROUP BY s.stop_id, s.stop_name, s.stop_lat, s.stop_lon, ${parentStationGroup}
               r.route_id, r.route_short_name, r.route_long_name, r.route_type
      ORDER BY s.stop_name
    `;
    
    const rows = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout')), 60000); // 60s for large datasets
      conn.all(query, (err, rows) => {
        clearTimeout(timeout);
        if (err) {
          console.error('[SQL] query-stops-with-routes ERROR:', err);
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
    
    console.log('[SQL] query-stops-with-routes SUCCESS:', rows.length, 'rows');
    
    // Group routes by stop
    const stopsMap = new Map();
    rows.forEach(row => {
      if (!stopsMap.has(row.stop_id)) {
        const stopData = {
          stop_id: row.stop_id,
          stop_name: row.stop_name,
          stop_lat: row.stop_lat,
          stop_lon: row.stop_lon,
          routes: []
        };
        // Only add parent_station if it exists in the schema
        if (hasParentStation) {
          stopData.parent_station = row.parent_station;
        }
        stopsMap.set(row.stop_id, stopData);
      }
      
      // Add route if it exists (some stops might not have routes)
      if (row.route_id) {
        const stop = stopsMap.get(row.stop_id);
        // Check if route already added (due to multiple trips)
        if (!stop.routes.find(r => r.route_id === row.route_id)) {
          stop.routes.push({
            route_id: row.route_id,
            route_short_name: row.route_short_name,
            route_long_name: row.route_long_name,
            route_type: row.route_type
          });
        }
      }
    });
    
    const result = Array.from(stopsMap.values()).map(stop => ({
      ...stop,
      routeCount: stop.routes.length
    }));
    
    return convertBigIntsToNumbers(result);
    
  } catch (err) {
    console.error('[SQL] query-stops-with-routes FAILED:', err);
    throw err;
  } finally {
    conn.close();
  }
});

// Query stops with pagination and search (NEW - for infinite scroll)
ipcMain.handle('query-stops-paginated', async (event, { searchQuery, offset, limit }) => {
  if (!db) throw new Error('Database not loaded');
  
  const conn = db.connect();
  
  try {
    console.log('[SQL] query-stops-paginated', { searchQuery, offset, limit });
    
    // Check if parent_station column exists
    let hasParentStation = false;
    try {
      const columnCheck = await new Promise((resolve, reject) => {
        conn.all("PRAGMA table_info(stops)", (err, rows) => {
          err ? reject(err) : resolve(rows);
        });
      });
      hasParentStation = columnCheck.some(col => col.name === 'parent_station');
      console.log('[SQL] parent_station column exists:', hasParentStation);
    } catch (err) {
      console.warn('[SQL] Could not check for parent_station column:', err);
    }
    
    // Build query with conditional parent_station
    const parentStationSelect = hasParentStation ? 's.parent_station,' : '';
    const parentStationGroup = hasParentStation ? 's.parent_station, ' : '';
    
    let query, params;
    const safeLimit = Math.min(Math.max(1, limit || 50), 200); // Cap at 200 for safety
    const safeOffset = Math.max(0, offset || 0);
    
    if (searchQuery && searchQuery.trim()) {
      // SEARCH MODE: Use ILIKE (case-insensitive) on stop_name only
      const searchTerm = `%${searchQuery.trim()}%`;
      
      query = `
        WITH distinct_routes AS (
          SELECT DISTINCT
            s.stop_id,
            r.route_id,
            r.route_short_name,
            r.route_long_name,
            r.route_type
          FROM stops s
          LEFT JOIN stop_times st ON s.stop_id = st.stop_id
          LEFT JOIN trips t ON st.trip_id = t.trip_id
          LEFT JOIN routes r ON t.route_id = r.route_id
          WHERE s.stop_name ILIKE ?
        ),
        stop_routes AS (
          SELECT 
            s.stop_id,
            s.stop_name,
            s.stop_lat,
            s.stop_lon,
            ${parentStationSelect}
            LIST(
              CASE 
                WHEN dr.route_id IS NOT NULL 
                THEN STRUCT_PACK(
                  route_id := dr.route_id,
                  route_short_name := dr.route_short_name,
                  route_long_name := dr.route_long_name,
                  route_type := dr.route_type
                )
                ELSE NULL
              END
            ) as routes_list,
            COUNT(dr.route_id) as route_count
          FROM stops s
          LEFT JOIN distinct_routes dr ON s.stop_id = dr.stop_id
          WHERE s.stop_name ILIKE ?
          GROUP BY s.stop_id, s.stop_name, s.stop_lat, s.stop_lon, ${parentStationGroup}
          ORDER BY s.stop_name
          LIMIT ? OFFSET ?
        )
        SELECT * FROM stop_routes
      `;
      params = [searchTerm, searchTerm, safeLimit, safeOffset];
      
    } else {
      // BROWSE MODE: Alphabetical pagination
      query = `
        WITH distinct_routes AS (
          SELECT DISTINCT
            s.stop_id,
            r.route_id,
            r.route_short_name,
            r.route_long_name,
            r.route_type
          FROM stops s
          LEFT JOIN stop_times st ON s.stop_id = st.stop_id
          LEFT JOIN trips t ON st.trip_id = t.trip_id
          LEFT JOIN routes r ON t.route_id = r.route_id
        ),
        stop_routes AS (
          SELECT 
            s.stop_id,
            s.stop_name,
            s.stop_lat,
            s.stop_lon,
            ${parentStationSelect}
            LIST(
              CASE 
                WHEN dr.route_id IS NOT NULL 
                THEN STRUCT_PACK(
                  route_id := dr.route_id,
                  route_short_name := dr.route_short_name,
                  route_long_name := dr.route_long_name,
                  route_type := dr.route_type
                )
                ELSE NULL
              END
            ) as routes_list,
            COUNT(dr.route_id) as route_count
          FROM stops s
          LEFT JOIN distinct_routes dr ON s.stop_id = dr.stop_id
          GROUP BY s.stop_id, s.stop_name, s.stop_lat, s.stop_lon, ${parentStationGroup}
          ORDER BY s.stop_name
          LIMIT ? OFFSET ?
        )
        SELECT * FROM stop_routes
      `;
      params = [safeLimit, safeOffset];
    }
    
    const rows = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout')), 30000);
      conn.all(query, ...params, (err, rows) => {
        clearTimeout(timeout);
        if (err) {
          console.error('[SQL] query-stops-paginated ERROR:', err);
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
    
    // Parse results in main process
    const result = rows.map(row => {
      const stopData = {
        stop_id: row.stop_id,
        stop_name: row.stop_name,
        stop_lat: row.stop_lat,
        stop_lon: row.stop_lon,
        routes: row.routes_list ? row.routes_list.filter(r => r !== null) : [],
        routeCount: Number(row.route_count || 0)
      };
      
      // Only add parent_station if it exists in the schema
      if (hasParentStation) {
        stopData.parent_station = row.parent_station;
      }
      
      return stopData;
    });
    
    console.log('[SQL] query-stops-paginated SUCCESS:', result.length, 'stops');
    return convertBigIntsToNumbers(result);
    
  } catch (err) {
    console.error('[SQL] query-stops-paginated FAILED:', err);
    throw err;
  } finally {
    conn.close();
  }
});

// Query total count of stops (with optional search filter)
ipcMain.handle('query-stops-count', async (event, { searchQuery }) => {
  if (!db) throw new Error('Database not loaded');
  
  const conn = db.connect();
  
  try {
    let query, params;
    
    if (searchQuery && searchQuery.trim()) {
      // Count ILIKE matches on stop_name only
      const searchTerm = `%${searchQuery.trim()}%`;
      query = `
        SELECT COUNT(*) as count 
        FROM stops 
        WHERE stop_name ILIKE ?
      `;
      params = [searchTerm];
    } else {
      // Count all stops
      query = `SELECT COUNT(*) as count FROM stops`;
      params = [];
    }
    
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout')), 10000);
      conn.all(query, ...params, (err, rows) => {
        clearTimeout(timeout);
        if (err) {
          reject(err);
        } else {
          resolve(rows && rows.length > 0 ? rows[0] : { count: 0 });
        }
      });
    });
    
    return Number(result.count || 0);
    
  } finally {
    conn.close();
  }
});

// ════════════════════════════════════════════════════════════════
// APP LIFECYCLE
// Prepare stop detail data - combines route and departure queries
ipcMain.handle('prepare-stop-detail-data', async (event, { stopId, date }) => {
  if (!db) throw new Error('Database not loaded');
  
  const conn = db.connect();
  
  try {
    console.log('[SQL] prepare-stop-detail-data START', { stopId, date });
    
    if (!stopId) {
      throw new Error('stopId is required');
    }
    
    if (!date || date.length !== 8) {
      throw new Error('date must be in YYYYMMDD format');
    }
    
    // Check which tables exist
    const tables = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout getting tables')), 10000);
      conn.all(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'`, 
        (err, rows) => {
          clearTimeout(timeout);
          if (err) reject(err);
          else resolve(rows);
        });
    });
    
    const tableSet = new Set(tables.map(t => t.table_name.toLowerCase()));
    const hasCalendar = tableSet.has('calendar');
    const hasCalendarDates = tableSet.has('calendar_dates');
    
    // Parse date for day of week
    const dateObj = new Date(
      parseInt(date.substring(0, 4)),
      parseInt(date.substring(4, 6)) - 1,
      parseInt(date.substring(6, 8))
    );
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayColumn = dayNames[dateObj.getDay()];
    
    // Build query based on available tables
    let query;
    let params;
    
    if (hasCalendar && hasCalendarDates) {
      query = `
        WITH active_services AS (
          SELECT service_id FROM calendar
          WHERE start_date <= $1 AND end_date >= $2 AND ${dayColumn} = '1'
          UNION
          SELECT service_id FROM calendar_dates WHERE date = $3 AND exception_type = '1'
          EXCEPT
          SELECT service_id FROM calendar_dates WHERE date = $4 AND exception_type = '2'
        )
        SELECT 
          t.trip_id,
          st.departure_time,
          t.trip_headsign,
          r.route_short_name,
          r.route_long_name,
          r.route_type,
          r.route_id,
          t.direction_id,
          t.service_id
        FROM stop_times st
        JOIN trips t ON st.trip_id = t.trip_id
        JOIN routes r ON t.route_id = r.route_id
        WHERE st.stop_id = $5 
          AND t.service_id IN (SELECT service_id FROM active_services)
        ORDER BY st.departure_time
      `;
      params = [date, date, date, date, stopId];
      
    } else if (hasCalendar) {
      query = `
        WITH active_services AS (
          SELECT service_id FROM calendar
          WHERE start_date <= $1 AND end_date >= $2 AND ${dayColumn} = '1'
        )
        SELECT 
          t.trip_id,
          st.departure_time,
          t.trip_headsign,
          r.route_short_name,
          r.route_long_name,
          r.route_type,
          r.route_id,
          t.direction_id,
          t.service_id
        FROM stop_times st
        JOIN trips t ON st.trip_id = t.trip_id
        JOIN routes r ON t.route_id = r.route_id
        WHERE st.stop_id = $3
          AND t.service_id IN (SELECT service_id FROM active_services)
        ORDER BY st.departure_time
      `;
      params = [date, date, stopId];
      
    } else {
      // No calendar tables - return all departures at this stop
      query = `
        SELECT 
          t.trip_id,
          st.departure_time,
          t.trip_headsign,
          r.route_short_name,
          r.route_long_name,
          r.route_type,
          r.route_id,
          t.direction_id,
          t.service_id
        FROM stop_times st
        JOIN trips t ON st.trip_id = t.trip_id
        JOIN routes r ON t.route_id = r.route_id
        WHERE st.stop_id = $1
        ORDER BY st.departure_time
      `;
      params = [stopId];
    }
    
    const rows = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Query timeout')), 30000);
      conn.all(query, ...params, (err, rows) => {
        clearTimeout(timeout);
        if (err) {
          console.error('[SQL] prepare-stop-detail-data ERROR:', err);
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
    
    console.log('[SQL] prepare-stop-detail-data SUCCESS:', rows.length, 'departures');
    
    // Build unique routes list
    const routesMap = new Map();
    rows.forEach(row => {
      if (!routesMap.has(row.route_id)) {
        routesMap.set(row.route_id, {
          route_id: row.route_id,
          route_short_name: row.route_short_name,
          route_long_name: row.route_long_name,
          route_type: row.route_type
        });
      }
    });
    
    return {
      departures: convertBigIntsToNumbers(rows || []),
      routes: Array.from(routesMap.values())
    };
    
  } catch (err) {
    console.error('[SQL] prepare-stop-detail-data FAILED:', err);
    throw err;
  } finally {
    conn.close();
  }
});

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
