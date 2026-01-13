console.log('utils.js loaded');
const Utils = {};
	
Utils.$ = (id) => document.getElementById(id);
Utils.$$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

Utils.debounce = function(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
   Utils.escapeHtml = function(s) {
      if (s === null || s === undefined) return '';
      return String(s).replace(/[&<>"']/g, function(m) { return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[m]; });
    }
	const keyCache = new Map();
    Utils.normalizeKey = function(k) {
      if (k === null || k === undefined) return k;
      
      // Check cache first
      if (keyCache.has(k)) return keyCache.get(k);
      
      let key = String(k).replace(/^\uFEFF/,'').trim().toLowerCase();
      const normalized = KEY_ALIAS[key] || key.replace(/\s+/g,'_');
      
      keyCache.set(k, normalized);
      return normalized;
    }
    Utils.normalizeRecord = function(rec) {
      if (!rec || typeof rec !== 'object') {
        console.warn('normalizeRecord: Invalid record, expected object');
        return {};
      }
      
      const out = Object.create(null); // Faster than {} (no prototype chain)
      const keys = Object.keys(rec);
      
      for (let i = 0; i < keys.length; i++) {
        const origKey = keys[i];
        const norm = Utils.normalizeKey(origKey);
        const val = rec[origKey];
        
        if (val === null || val === undefined) {
          out[norm] = '';
        } else {
          const str = String(val);
          // Optimize: Combined quote removal and trim
          const hasStartQuote = str[0] === '"';
          const hasEndQuote = str[str.length - 1] === '"';
          
          if (hasStartQuote && hasEndQuote) {
            // Remove surrounding quotes and trim
            out[norm] = str.substring(1, str.length - 1).trim();
          } else if (hasStartQuote || hasEndQuote) {
            // Only one quote - just remove and trim
            out[norm] = str.replace(/^"|"$/g, '').trim();
          } else {
            // No quotes - just trim
            out[norm] = str.trim();
          }
        }
      }
      return out;
    }
	/**
 * Fast time parser with caching (no string split)
 * Handles GTFS time format: "HH:MM:SS" (including >24h times like "25:30:00")
 * @param {string} timeStr - Time string
 * @returns {number} - Minutes since midnight (can be >1440 for next-day service)
 */
 Utils.parseTimeFast = function(timeStr) {
  if (!timeStr) return 0;
  
  // Check cache first (many stop_times share same times like "08:00:00")
  if (TIME_PARSE_CACHE.has(timeStr)) {
    return TIME_PARSE_CACHE.get(timeStr);
  }
  
  // Fast parse using charCodeAt (no string allocation)
  // "08:30:00" → extract HH and MM directly
  // Handle edge cases for single digit or malformed times
  let h = 0, m = 0;
  const len = timeStr.length;
  
  if (len >= 5) {
    // Standard format "HH:MM" or "HH:MM:SS"
    h = (timeStr.charCodeAt(0) - 48) * 10 + (timeStr.charCodeAt(1) - 48);
    m = (timeStr.charCodeAt(3) - 48) * 10 + (timeStr.charCodeAt(4) - 48);
  } else {
    // Fallback for malformed times
    const parts = timeStr.split(':');
    h = parseInt(parts[0] || '0', 10);
    m = parseInt(parts[1] || '0', 10);
  }
  
  const result = h * 60 + m;
  
  // Cache for reuse
  TIME_PARSE_CACHE.set(timeStr, result);
  
  return result;
}

    Utils.timeToMinutes = function(timeStr) {
      return parseTimeFast(timeStr);
    }
   Utils.minutesToTime = function(minutes) {
      if (!minutes && minutes !== 0) return '';
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      const s = 0;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    Utils.formatTime = function(time) {
      if (!time) return '<';
      const str = String(time);
      const parts = str.split(':');
      let hours = parseInt(parts[0]||'0',10);
      const minutes = parts[1]||'00';
      if (hours >= 24) hours = hours - 24;
      return `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}`;
    }
    Utils.parseGTFSDate = function(dateStr) {
      if(!dateStr || dateStr.length!==8) return null;
      return new Date(parseInt(dateStr.substring(0,4)), parseInt(dateStr.substring(4,6)) - 1, parseInt(dateStr.substring(6,8)));
    }
    Utils.formatDateToGTFS = function(date) {
      return date.getFullYear() + String(date.getMonth()+1).padStart(2,'0') + String(date.getDate()).padStart(2,'0');
    }

// ═══════════════════════════════════════════════════════════════
// TIME & DATE UTILITIES MODULE (Unified API)
// ═══════════════════════════════════════════════════════════════

const TimeUtils = {
  toMinutes: Utils.timeToMinutes,
  fromMinutes: Utils.minutesToTime,
  format: Utils.formatTime,
  parseDate: Utils.parseGTFSDate,
  formatDate: Utils.formatDateToGTFS,
  
  addDays(dateStr, days) {
    const date = this.parseDate(dateStr);
    if (!date) return null;
    date.setDate(date.getDate() + days);
    return this.formatDate(date);
  },
  
  daysBetween(date1Str, date2Str) {
    const y1 = parseInt(date1Str.substring(0, 4), 10);
    const m1 = parseInt(date1Str.substring(4, 6), 10) - 1;
    const d1 = parseInt(date1Str.substring(6, 8), 10);
    const y2 = parseInt(date2Str.substring(0, 4), 10);
    const m2 = parseInt(date2Str.substring(4, 6), 10) - 1;
    const d2 = parseInt(date2Str.substring(6, 8), 10);
    
    const ms1 = new Date(y1, m1, d1).getTime();
    const ms2 = new Date(y2, m2, d2).getTime();
    return Math.floor((ms2 - ms1) / (1000 * 60 * 60 * 24));
  },
  
  getDayOfWeek(dateStr) {
    const date = this.parseDate(dateStr);
    return date ? date.getDay() : null;
  },
  
  calculateEaster(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
  },
  
  getPolishHolidays(year) {
    const holidays = [];
    holidays.push({ date: `${year}0101`, name: 'Nowy Rok' });
    holidays.push({ date: `${year}0501`, name: 'Święto Pracy' });
    holidays.push({ date: `${year}0815`, name: 'Wniebowzięcie NMP' });
    holidays.push({ date: `${year}1101`, name: 'Wszystkich Świętych' });
    holidays.push({ date: `${year}1225`, name: 'Boże Narodzenie' });
    holidays.push({ date: `${year}1226`, name: 'Drugi dzień Świąt' });
    
    const easter = this.calculateEaster(year);
    const easterMonday = new Date(easter);
    easterMonday.setDate(easter.getDate() + 1);
    holidays.push({ date: this.formatDate(easterMonday), name: 'Poniedziałek Wielkanocny' });
    
    const corpusChristi = new Date(easter);
    corpusChristi.setDate(easter.getDate() + 60);
    holidays.push({ date: this.formatDate(corpusChristi), name: 'Boże Ciało' });
    
    return holidays;
  },
  
  findUpcomingHolidays(referenceDateStr, daysAhead = 7) {
    const refYear = parseInt(referenceDateStr.substring(0, 4), 10);
    const holidays = [
      ...this.getPolishHolidays(refYear),
      ...this.getPolishHolidays(refYear + 1)
    ];
    
    const upcoming = [];
    holidays.forEach(holiday => {
      const days = this.daysBetween(referenceDateStr, holiday.date);
      if (days >= 0 && days <= daysAhead) {
        upcoming.push({ ...holiday, daysFromNow: days });
      }
    });
    
    return upcoming.sort((a, b) => a.daysFromNow - b.daysFromNow);
  }
};

// ═══════════════════════════════════════════════════════════════
// 3.3. GEOMETRY AND GEOGRAPHY MODULE
// ═══════════════════════════════════════════════════════════════
     Utils.simplifyDouglasPeucker = function(points, tolerance = 0.0001) {
      if (!points || points.length <= 2) return points;
      
      function perpendicularDistance(point, lineStart, lineEnd) {
        const [x, y] = point;
        const [x1, y1] = lineStart;
        const [x2, y2] = lineEnd;
        
        const dx = x2 - x1;
        const dy = y2 - y1;
        
        if (dx === 0 && dy === 0) {
          return Math.sqrt((x - x1) ** 2 + (y - y1) ** 2);
        }
        
        const numerator = Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1);
        const denominator = Math.sqrt(dx ** 2 + dy ** 2);
        
        return numerator / denominator;
      }
      
       Utils.simplifyRecursive = function(points, tolerance, startIdx, endIdx) {
        let maxDistance = 0;
        let maxIndex = 0;
        
        for (let i = startIdx + 1; i < endIdx; i++) {
          const distance = perpendicularDistance(
            points[i],
            points[startIdx],
            points[endIdx]
          );
          
          if (distance > maxDistance) {
            maxDistance = distance;
            maxIndex = i;
          }
        }
        
        // If max distance is greater than tolerance, recursively simplify
        if (maxDistance > tolerance) {
          const leftPart = Utils.simplifyRecursive(points, tolerance, startIdx, maxIndex);
          const rightPart = Utils.simplifyRecursive(points, tolerance, maxIndex, endIdx);
          
          // Combine results (remove duplicate point at junction)
          return leftPart.slice(0, -1).concat(rightPart);
        } else {
          // Return just endpoints
          return [points[startIdx], points[endIdx]];
        }
      }
      
      return Utils.simplifyRecursive(points, tolerance, 0, points.length - 1);
    }
Utils.haversineDistance = function(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}
Utils.calculateShapeCoverage = function(stops, shapePoints) {
  const MAX_DISTANCE_METERS = 100; // 100m tolerance (configurable heuristic)
  const nearbyStops = [];
  
  stops.forEach((stop, index) => {
    const stopLat = parseFloat(stop.lat || stop.stop_lat);
    const stopLon = parseFloat(stop.lon || stop.stop_lon);
    
    if (isNaN(stopLat) || isNaN(stopLon)) return;
    
    let minDistance = Infinity;
    let nearestShapeIndex = -1;
    
    shapePoints.forEach((shapePoint, shapeIndex) => {
      const distance = haversineDistance(
        stopLat, stopLon,
        shapePoint[0], shapePoint[1]
      );
      
      if (distance < minDistance) {
        minDistance = distance;
        nearestShapeIndex = shapeIndex;
      }
    });
    
    if (minDistance < MAX_DISTANCE_METERS) {
      nearbyStops.push({
        stopIndex: index,
        shapeIndex: nearestShapeIndex,
        distance: minDistance
      });
    }
  });
  
  return {
    percentage: nearbyStops.length / stops.length,
    nearbyStops: nearbyStops
  };
}
Utils.fillShapeGaps = function(stops, shapePoints, nearbyStops) {
  const result = [];
  
  for (let i = 0; i < stops.length - 1; i++) {
    const currentStop = stops[i];
    const nextStop = stops[i + 1];
    
    const currentNearby = nearbyStops.find(n => n.stopIndex === i);
    const nextNearby = nearbyStops.find(n => n.stopIndex === i + 1);
    
    // Case 1: Both stops covered by shape - use shape segment
    if (currentNearby && nextNearby) {
      const startIdx = currentNearby.shapeIndex;
      const endIdx = nextNearby.shapeIndex;
      
      if (endIdx > startIdx) {
        const segment = shapePoints.slice(startIdx, endIdx + 1);
        result.push(...segment);
      } else {
        // Shape goes backwards - use straight line
        result.push(
          [parseFloat(currentStop.lat || currentStop.stop_lat), parseFloat(currentStop.lon || currentStop.stop_lon)],
          [parseFloat(nextStop.lat || nextStop.stop_lat), parseFloat(nextStop.lon || nextStop.stop_lon)]
        );
      }
    }
    // Case 2: Gap in shape - fill with straight line
    else {
      if (i === 0 || result.length === 0) {
        result.push([parseFloat(currentStop.lat || currentStop.stop_lat), parseFloat(currentStop.lon || currentStop.stop_lon)]);
      }
      result.push([parseFloat(nextStop.lat || nextStop.stop_lat), parseFloat(nextStop.lon || nextStop.stop_lon)]);
    }
  }
  
  return result;
};

window.Utils = Utils;
console.log('Utils exposed', Utils);