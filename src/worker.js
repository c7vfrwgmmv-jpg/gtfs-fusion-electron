BigInt.prototype.toJSON = function () {
  return this.toString();
};

const TIME_CACHE = new Map();

function parseTimeFast(timeStr) {
  if (!timeStr) return 0;

  if (TIME_CACHE.has(timeStr)) {
    return TIME_CACHE.get(timeStr);
  }

  let h = 0, m = 0;
  const len = timeStr.length;

  if (len >= 5) {
    h = (timeStr.charCodeAt(0) - 48) * 10 + (timeStr.charCodeAt(1) - 48);
    m = (timeStr.charCodeAt(3) - 48) * 10 + (timeStr.charCodeAt(4) - 48);
  } else {
    const parts = timeStr.split(':');
    h = parseInt(parts[0] || '0', 10);
    m = parseInt(parts[1] || '0', 10);
  }

  const result = h * 60 + m;
  TIME_CACHE.set(timeStr, result);
  return result;
}

/* ===========================
   CSV helpers
=========================== */

function parseCSVLine(line) {
  if (!line) return [];

  if (!line.includes('"')) {
    return line.split(',');
  }

  const result = [];
  const chars = [];
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        chars.push('"');
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(chars.join(''));
      chars.length = 0;
    } else {
      chars.push(char);
    }
  }

  result.push(chars.join(''));
  return result;
}

/* ===========================
   Key normalization
=========================== */

const KEY_ALIAS = {
  'route id':'route_id','routeid':'route_id','route_id':'route_id',
  'route short name':'route_short_name','route_short_name':'route_short_name',
  'route long name':'route_long_name','route_long_name':'route_long_name',
  'trip id':'trip_id','tripid':'trip_id','trip_id':'trip_id',
  'service id':'service_id','serviceid':'service_id','service_id':'service_id',
  'stop id':'stop_id','stopid':'stop_id','stop_id':'stop_id',
  'stop sequence':'stop_sequence','stop_sequence':'stop_sequence',
  'arrival time':'arrival_time','arrival_time':'arrival_time',
  'departure time':'departure_time','departure_time':'departure_time',
  'pickup type':'pickup_type','pickup_type':'pickup_type',
  'drop off type':'drop_off_type','drop_off_type':'drop_off_type',
  'shape id':'shape_id','shapeid':'shape_id','shape_id':'shape_id',
  'shape_pt_lat':'shape_pt_lat','shape_pt_lon':'shape_pt_lon',
  'shape_pt_sequence':'shape_pt_sequence'
};

const keyCache = new Map();

function normalizeKey(k) {
  if (k == null) return k;
  if (keyCache.has(k)) return keyCache.get(k);

  const key = String(k).replace(/^\uFEFF/, '').trim().toLowerCase();
  const normalized = KEY_ALIAS[key] || key.replace(/\s+/g, '_');

  keyCache.set(k, normalized);
  return normalized;
}

function normalizeRecord(rec) {
  const out = Object.create(null);

  for (const k in rec) {
    const nk = normalizeKey(k);
    const v = rec[k];
    out[nk] = v == null ? '' : String(v).replace(/^"|"$/g, '').trim();
  }

  return out;
}

/* ===========================
   parseCSV
=========================== */

function parseCSV(text) {
  if (!text) return [];

  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  if (!lines.length) return [];

  const headers = parseCSVLine(lines[0]).map(h => h.trim());
  const result = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;

    const values = parseCSVLine(line);
    const row = {};

    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (values[j] || '').trim();
    }

    result.push(normalizeRecord(row));
  }

  return result;
}

/* ===========================
   stop_times chunk parsing
=========================== */

function parseStopTimesChunk(text, headers) {
  const index = Object.create(null);
  const lines = text.split('\n');

  const get = (cols, i) => (i >= 0 && i < cols.length ? cols[i].replace(/^"|"$/g, '').trim() : '');

  for (const line of lines) {
    if (!line) continue;
    const cols = line.split(',');

    const tripId = get(cols, headers.tripIdx);
    const stopId = get(cols, headers.stopIdx);
    if (!tripId || !stopId) continue;

    if (!index[tripId]) index[tripId] = [];

    index[tripId].push({
      stop_id: stopId,
      arrival_time: get(cols, headers.arrIdx),
      departure_time: get(cols, headers.depIdx),
      stop_sequence: parseInt(get(cols, headers.seqIdx) || '0', 10),
      pickup_type: get(cols, headers.pickupIdx) || '0',
      drop_off_type: get(cols, headers.dropoffIdx) || '0'
    });
  }

  return index;
}

/* ===========================
   shapes chunk parsing
=========================== */

function parseShapesChunk(text) {
  const index = {};
  const lines = text.split('\n');
  if (!lines.length) return index;

  const rawHeaders = lines[0].split(',').map(h => normalizeKey(h.replace(/^"|"$/g, '')));
  const h = {
    shape: rawHeaders.indexOf('shape_id'),
    lat: rawHeaders.indexOf('shape_pt_lat'),
    lon: rawHeaders.indexOf('shape_pt_lon'),
    seq: rawHeaders.indexOf('shape_pt_sequence')
  };

  if (h.shape === -1 || h.lat === -1 || h.lon === -1) return index;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const id = cols[h.shape];
    if (!id) continue;

    const lat = parseFloat(cols[h.lat]);
    const lon = parseFloat(cols[h.lon]);
    const seq = h.seq !== -1 ? parseInt(cols[h.seq] || '0', 10) : 0;

    if (isNaN(lat) || isNaN(lon)) continue;

    if (!index[id]) index[id] = [];
    index[id].push({ lat, lon, seq });
  }

  for (const k in index) {
    index[k].sort((a, b) => a.seq - b.seq);
    index[k] = index[k].map(p => [p.lat, p.lon]);
  }

  return index;
}

/* ===========================
   Message handler
=========================== */

self.onmessage = function (e) {
  const { type, text, fileType, headers, chunkId } = e.data;
  if (type !== 'parse') return;

  try {
    let result;

    if (fileType === 'stop_times' && headers) {
      result = parseStopTimesChunk(text, headers);
    } else if (fileType === 'shapes') {
      result = parseShapesChunk(text);
    } else {
      const records = parseCSV(text);

      if (fileType === 'stop_times') {
        for (const r of records) {
          if (r.arrival_time) r.arrival_time = parseTimeFast(r.arrival_time);
          if (r.departure_time) r.departure_time = parseTimeFast(r.departure_time);
          if (r.stop_sequence) r.stop_sequence = parseInt(r.stop_sequence, 10);
        }
      }

      result = records;
    }

    self.postMessage({ type: 'result', data: result, chunkId });
  } catch (err) {
    self.postMessage({ type: 'error', error: err.message, chunkId });
  }
};