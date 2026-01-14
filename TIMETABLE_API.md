# Stop Timetable API Documentation

## Overview

The `query-timetable-for-stop` API provides fully aggregated timetable data for a specific stop. **All aggregation logic, annotations, and terminus detection is performed on the backend.** The frontend only renders the provided data structure.

## Why Backend Aggregation?

- **Performance**: Complex aggregation happens once on the backend using optimized SQL queries
- **Consistency**: Same logic for all clients
- **Maintainability**: Business logic centralized in one place
- **Simplicity**: Frontend code is minimal and focused on rendering

⚠️ **Warning**: Do NOT attempt to re-aggregate or re-analyze the timetable data on the frontend. The backend provides the complete, final data structure ready for display.

## Event Delegation for Stop Items

The `.stop-item` elements use event delegation for reliable click handling:

```javascript
// Event delegation pattern - handler is attached to parent container
const stopsListEl = document.getElementById('stops-list');
if (stopsListEl) {
  if (stopsListEl._stopItemHandler) {
    stopsListEl.removeEventListener('click', stopsListEl._stopItemHandler);
  }
  const handler = (e) => {
    const stopItem = e.target.closest('.stop-item');
    if (stopItem) {
      const stopId = stopItem.getAttribute('data-stop-id');
      if (stopId && state.gtfsData && state.gtfsData.stopsIndex[stopId]) {
        state.selectedStop = state.gtfsData.stopsIndex[stopId];
        state.stopViewFilteredRoutes = [];
        render();
      }
    }
  };
  stopsListEl._stopItemHandler = handler;
  stopsListEl.addEventListener('click', handler);
}
```

### Why Event Delegation?

1. **Resilient to DOM changes**: Works even after virtual scrolling, pagination, or search rerenders
2. **Performance**: Single event listener instead of hundreds
3. **Simplicity**: One handler for all `.stop-item` elements
4. **Memory efficient**: No need to track individual element handlers

### When is the Handler Attached?

The event delegation handler is reattached:
- After initial render of stops list
- After pagination (loading more stops)
- After search query changes
- After expanding/collapsing stop groups

## API Reference

### Request

```javascript
const timetableData = await window.electronAPI.queryTimetableForStop({
  stopId: 'STOP_12345',      // Required: Stop ID
  date: '20240315',          // Required: Date in YYYYMMDD format
  routeId: 'ROUTE_1'         // Optional: Filter to specific route
});
```

### Response Structure

```json
{
  "columns": {
    "weekday": {
      "name": "Dzień powszedni",
      "times": {
        "4": ["30", "45"],
        "5": ["00", "15", "30", "45"],
        "6": ["00a", "15¹", "30", "45²"]
      }
    },
    "saturday": {
      "name": "Sobota",
      "times": {
        "6": ["00", "30"],
        "7": ["00", "30"]
      },
      "isHoliday": false
    },
    "sunday": {
      "name": "Niedziela",
      "times": {
        "8": ["00", "30"],
        "9": ["00", "30"]
      },
      "isHoliday": false
    },
    "weekdayHolidays": [
      {
        "name": "Boże Narodzenie",
        "date": "20241225",
        "times": {
          "10": ["00", "30"]
        }
      }
    ]
  },
  "legends": [
    {
      "type": "weekday",
      "items": [
        {
          "symbol": "¹",
          "description": "poniedziałek"
        },
        {
          "symbol": "²",
          "description": "wtorek, czwartek"
        }
      ]
    },
    {
      "type": "terminus",
      "items": [
        {
          "symbol": "a",
          "description": "do Dworzec Główny"
        }
      ]
    }
  ],
  "metadata": {
    "stopId": "STOP_12345",
    "date": "20240315",
    "routeId": "ROUTE_1",
    "mainDestination": "Centrum",
    "weekDates": {
      "monday": "20240311",
      "tuesday": "20240312",
      "wednesday": "20240313",
      "thursday": "20240314",
      "friday": "20240315",
      "saturday": "20240316",
      "sunday": "20240317"
    }
  }
}
```

### Field Descriptions

#### `columns`

Contains timetable data organized by day type:
- **weekday**: Mon-Fri departures (excluding weekday holidays)
- **saturday**: Saturday departures (or holiday if Saturday is a holiday)
- **sunday**: Sunday departures (or holiday if Sunday is a holiday)
- **weekdayHolidays**: Array of Mon-Fri holidays as separate columns

Each column has:
- **name**: Display name (e.g., "Dzień powszedni", "Sobota", "Boże Narodzenie")
- **times**: Object mapping hour (0-23) to array of minutes
- **isHoliday** (optional): Boolean indicating if this is a holiday

#### Minute Format

Minutes include annotations as suffix characters:
- **Lowercase letters** (a, b, c...): Alternative terminus
  - Example: `"30a"` = minute 30, goes to alternative destination 'a'
- **Superscript numbers** (¹, ², ³...): Weekday annotation (only in weekday column)
  - Example: `"15¹"` = minute 15, runs only on specific weekday(s)

#### `legends`

Array of legend objects explaining annotations:

**Weekday Legend**:
```json
{
  "type": "weekday",
  "items": [
    {
      "symbol": "¹",
      "description": "poniedziałek"
    }
  ]
}
```

**Terminus Legend**:
```json
{
  "type": "terminus",
  "items": [
    {
      "symbol": "a",
      "description": "do Dworzec Główny"
    }
  ]
}
```

#### `metadata`

Additional context:
- **stopId**: Requested stop ID
- **date**: Requested date
- **routeId**: Requested route filter (if any)
- **mainDestination**: Most common destination name
- **weekDates**: Map of day names to dates for the week

## Frontend Rendering

The frontend displays the backend data with minimal processing:

```javascript
// Example: Format hours from backend data
function formatTimesByHour(timesByHour) {
  const rows = [];
  const hourOrder = [4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,0,1,2,3];
  const hours = hourOrder.filter(h => timesByHour.hasOwnProperty(h));
  
  hours.forEach((hour, index) => {
    const hourPadded = String(hour).padStart(2,'0');
    const minutes = timesByHour[hour].join('  '); // Join minutes with spaces
    const bgColor = index % 2 === 0 ? '#e4e7eb' : '#ffffff';
    rows.push(`
      <div style="background: ${bgColor}; padding: 0.1rem 0.25rem;">
        <span class="hour-label">${hourPadded}</span>
        <span class="minutes">${minutes}</span>
      </div>
    `);
  });
  
  return rows.join('');
}
```

### Rendering Annotations

The frontend can add visual emphasis to annotations:

```javascript
// Optional: Wrap superscripts in <sup> tags for better styling
function enhanceMinuteDisplay(minute) {
  // minute might be: "30", "30a", "30¹", "30a¹"
  return minute.replace(/([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g, '<sup>$1</sup>');
}
```

## Implementation Notes

### Backend Algorithm

1. **Week Detection**: Finds Monday of the week containing the target date
2. **Holiday Detection**: Identifies Polish holidays in that week
3. **Service Calculation**: Determines which services run on each day
4. **Terminus Detection**: Finds most common destination (main terminus)
5. **Annotation Logic**:
   - Assigns lowercase letters to alternative termini
   - Assigns superscript numbers to minority weekday patterns
6. **Aggregation**: Groups departures by hour and applies annotations

### Weekday Annotation Algorithm

Only annotates when necessary (minority pattern in a complementary set):

- If all departures run Mon-Fri: no annotation
- If some run only on specific days: annotate the minority
- Example: If 80% run Mon-Fri and 20% run only Mon,Wed,Fri:
  - Annotate Mon,Wed,Fri pattern with superscript
  - Leave Mon-Fri pattern unmarked

### Performance Characteristics

- **Query Time**: ~50-200ms for typical stop (depends on feed size)
- **Data Size**: ~5-50KB JSON response (typical)
- **Caching**: Backend uses DuckDB query optimization
- **Scalability**: Handles feeds with millions of stop_times

## Error Handling

```javascript
try {
  const data = await window.electronAPI.queryTimetableForStop({
    stopId: 'STOP_123',
    date: '20240315'
  });
  
  if (!data || !data.columns) {
    console.error('Invalid response from backend');
    return;
  }
  
  // Render data...
  
} catch (err) {
  console.error('Failed to load timetable:', err);
  alert('Nie udało się załadować rozkładu jazdy: ' + err.message);
}
```

## Testing

To test the API:

```javascript
// In browser console (after loading GTFS data):
const data = await window.electronAPI.queryTimetableForStop({
  stopId: 'YOUR_STOP_ID',
  date: '20240315'
});
console.log(JSON.stringify(data, null, 2));
```

## Migration Notes

If migrating from frontend-aggregated timetables:

1. **Remove** client-side aggregation logic
2. **Remove** terminus detection code
3. **Remove** annotation logic
4. **Keep** only rendering functions
5. **Update** to use new API response structure

## See Also

- `main.js` - Backend implementation
- `index.html` - Frontend rendering (showStopTimetableModal function)
- `gtfs-fusion-v3.html` - Original reference implementation
