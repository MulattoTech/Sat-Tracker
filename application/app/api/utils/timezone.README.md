# Server-Side Timezone Utilities

This module provides utilities for handling timezone conversions and date formatting on the server side.

## Core Functions

### `getSettings(): Promise<{ timezone: string }>`

Retrieves the server's timezone settings from the database.

```typescript
import { getSettings } from '../utils/timezone';

// Get server timezone settings
const settings = await getSettings();
console.log(`Server timezone: ${settings.timezone}`);
```

### `toUTC(dateInput: string | Date): Date`

Converts a date string or Date object to UTC for storage in the database.

```typescript
import { toUTC } from '../utils/timezone';

// Convert a date string to UTC
const utcDate = toUTC('2025-03-15T14:30:00');

// Store in database
await prisma.feedLog.create({
  data: {
    time: utcDate,
    // other fields...
  }
});
```

### `formatForResponse(date: Date | string | null): string | null`

Formats a date for API responses in ISO format.

```typescript
import { formatForResponse } from '../utils/timezone';

// Format a date for API response
const response = {
  ...feedLog,
  time: formatForResponse(feedLog.time),
  // other fields...
};
```

### `calculateDurationMinutes(startDate: Date | string, endDate: Date | string): number`

Calculates the duration between two dates in minutes.

```typescript
import { calculateDurationMinutes } from '../utils/timezone';

// Calculate duration between start and end time
const duration = calculateDurationMinutes(startTime, endTime);
```

### `formatDuration(minutes: number): string`

Formats a duration in minutes to a human-readable string (HH:MM).

```typescript
import { formatDuration } from '../utils/timezone';

// Format duration for display
const formattedDuration = formatDuration(90); // Returns "1:30"
```

## Best Practices

1. Always store dates in UTC format in the database
2. Use ISO strings for date serialization in API responses
3. Use the timezone utilities for all date operations
4. Handle timezone conversions on the client side for display

## Migration from Previous Version

If you were previously using the removed functions:

- `convertToUTC` → Use `toUTC` instead
- `formatLocalTime` → Use `formatForResponse` instead
- `convertUTCToTimezone` → This should be handled on the client side
- `getMinutesBetweenDates` → Use `calculateDurationMinutes` instead

The timezone API route (`/api/timezone`) has been removed as part of this refactoring. Timezone detection and conversion for display should now be handled on the client side.
