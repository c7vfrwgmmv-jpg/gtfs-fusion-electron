# Testing Guide for Stop Timetable Implementation

## Overview

This PR implements a comprehensive backend API for stop timetable aggregation with frontend integration. The timetable modal is triggered **only from the route timetable view** when clicking on stop names.

## What Was Implemented

### Backend API (`query-timetable-for-stop`)
- **Location**: `main.js`, lines 1948-2547
- **Purpose**: Fully aggregates timetable data on the backend
- **Features**:
  - Weekday/weekend/holiday grouping
  - Polish holiday detection
  - Minute annotations for partial weekday patterns (superscript numbers)
  - Terminus annotations for alternative destinations (lowercase letters)
  - Complete legends for all annotations

### Frontend Integration
- **Modal Function**: `showStopTimetableModal()` in `index.html` (lines 3945-4130)
- **Entry Point**: `openStopTimetable()` in `index.html` (lines 3950-3970)
- **Trigger**: Click on stop name in route timetable table (line 5977)

### Event Delegation
- **Existing Implementation**: `setupStopClickHandlers()` in `index.html` (lines 5003-5118)
- **Purpose**: Handles `.stop-item` clicks in stops list view
- **Behavior**: Navigates to stop detail view (NOT the timetable modal)

## Testing Checklist

### 1. Backend API Testing

Open the developer console and test the API directly:

```javascript
// Load GTFS data first, then test:
const data = await window.electronAPI.queryTimetableForStop({
  stopId: 'YOUR_STOP_ID',  // Replace with actual stop ID from your GTFS
  date: '20240315',        // Replace with valid date
  routeId: null            // Optional: filter to specific route
});

console.log(JSON.stringify(data, null, 2));
```

**Expected Result**:
- JSON object with `columns`, `legends`, and `metadata` properties
- `columns.weekday.times` contains hour->minutes mapping
- Minutes may have annotations (e.g., "30a" or "15¹")
- `legends` array explains all annotations

### 2. Route Timetable Modal Testing

**Steps**:
1. Load GTFS data
2. Select a route from the routes list
3. View the route timetable (should show the schedule table)
4. Click on any **stop name** in the leftmost column

**Expected Result**:
- Modal appears showing timetable for that stop
- Modal displays route badge if route is selected
- Table has columns: Weekday, Saturday, Sunday (+ any weekday holidays)
- Times are grouped by hour (4-23, 0-3)
- Annotations appear as superscripts or lowercase letters
- Legend appears at bottom explaining annotations
- Click outside modal or press Escape to close

**What to Check**:
- [ ] Modal opens when clicking stop name
- [ ] Modal shows correct stop name in header
- [ ] Route badge displays correctly (if route selected)
- [ ] Weekday column shows times with annotations (if applicable)
- [ ] Weekend columns show times
- [ ] Holiday columns appear if date falls in holiday week
- [ ] Legends explain annotations correctly
- [ ] Modal closes on Escape key
- [ ] Modal closes when clicking background

### 3. Stop List Event Delegation Testing

**Steps**:
1. Switch to stops view (Zobacz: przystanki)
2. Search for stops (type in search box)
3. Expand a multi-stop group
4. Click on individual stop items

**Expected Result**:
- Clicking stop navigates to stop detail view (NOT modal)
- Clicking works after:
  - Initial render
  - Pagination (scroll to load more)
  - Search query changes
  - Expanding/collapsing groups

**What to Check**:
- [ ] Single-stop groups clickable
- [ ] Expanded stop items clickable
- [ ] Clicks work after pagination
- [ ] Clicks work after search
- [ ] Clicks work after group expand/collapse
- [ ] Map zooms to selected stop
- [ ] Stop detail view loads correctly

### 4. Edge Cases

**Test with various GTFS datasets**:
- [ ] Dataset with no holidays in selected week
- [ ] Dataset with Saturday holiday
- [ ] Dataset with Sunday holiday  
- [ ] Dataset with weekday holiday (Mon-Fri)
- [ ] Route with no alternative termini
- [ ] Route with multiple alternative termini
- [ ] Stop with departures only on specific weekdays
- [ ] Stop with departures running all weekdays

**Test annotation limits**:
- [ ] More than 9 unique weekday patterns in one hour (should use '*' as fallback)
- [ ] More than 26 alternative termini (should continue with 'aa', 'ab', etc.)

### 5. Performance Testing

**Large datasets**:
- [ ] Timetable modal loads in < 2 seconds
- [ ] Backend API responds in < 500ms (check console logs)
- [ ] No UI freezing when clicking stop names
- [ ] Pagination smooth in stops list
- [ ] Search responsive (< 300ms delay)

## Common Issues

### Modal doesn't open
- Check browser console for errors
- Verify `openStopTimetable` is defined globally
- Verify stop ID exists in `state.gtfsData.stopsIndex`
- Check that backend API is responding (check network/IPC logs)

### Missing annotations
- Verify date falls within GTFS calendar dates
- Check that trips have varying service patterns
- Look for backend errors in main process console
- Verify `legends` array is populated in API response

### Click handler not working
- Check that `setupStopClickHandlers()` is being called
- Verify event delegation is attached to parent container
- Check browser console for JavaScript errors
- Ensure DOM structure matches expected selectors

## Backend Logs

Enable verbose logging by checking main process console:

```
[SQL] query-timetable-for-stop START
[SQL] query-timetable-for-stop SUCCESS
```

If you see errors, check:
- Database connection
- Stop ID validity
- Date format (must be YYYYMMDD)
- DuckDB table schema

## Performance Metrics

Expected performance (from TIMETABLE_API.md):
- **Query Time**: 50-200ms for typical stop
- **Data Size**: 5-50KB JSON response
- **Scalability**: Handles feeds with millions of stop_times

## Reporting Issues

When reporting issues, include:
1. GTFS dataset used
2. Stop ID and date tested
3. Browser console errors
4. Main process console logs
5. Expected vs actual behavior
6. Screenshots of modal (if applicable)

## Success Criteria

The implementation is successful if:
- [x] Backend API returns valid JSON for all stops
- [x] Modal opens from route timetable view
- [x] Annotations display correctly
- [x] Legends explain all annotations
- [x] Stop list clicks navigate to detail view
- [x] No errors in console
- [x] Performance within expected ranges
