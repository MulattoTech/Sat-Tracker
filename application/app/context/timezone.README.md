# Timezone Context

A React Context provider for handling timezone-related functionality in the Baby Tracker application. This context provides timezone information and utility functions to components throughout the application, ensuring consistent timezone handling, especially during Daylight Saving Time (DST) changes.

## Features

- Automatically detects the user's local timezone
- Provides comprehensive date formatting utilities
- Handles DST changes correctly in duration calculations
- Formats dates in the user's timezone
- Provides helper functions for common date operations

## Usage

### Provider Setup

The TimezoneProvider is already set up in the application's root layout:

```tsx
// app/layout.tsx
import { TimezoneProvider } from './context/timezone';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <BabyProvider>
      <TimezoneProvider>
        <html lang="en">
          <body>
            {children}
          </body>
        </html>
      </TimezoneProvider>
    </BabyProvider>
  );
}
```

### Using the Context

```tsx
import { useTimezone } from '@/app/context/timezone';

function MyComponent() {
  const { 
    userTimezone, 
    formatDate,
    formatTime,
    formatDateOnly,
    formatDateTime,
    calculateDurationMinutes,
    formatDuration,
    isToday,
    isYesterday
  } = useTimezone();
  
  // Display the user's timezone
  console.log(`User timezone: ${userTimezone}`);
  
  // Format a date in the user's timezone
  const formattedDate = formatDateTime('2025-03-10T14:30:00Z');
  
  // Format just the time portion
  const formattedTime = formatTime('2025-03-10T14:30:00Z');
  
  // Format just the date portion
  const formattedDateOnly = formatDateOnly('2025-03-10T14:30:00Z');
  
  // Calculate duration between dates
  const startDate = '2025-03-10T01:30:00Z';
  const endDate = '2025-03-10T03:30:00Z';
  const minutes = calculateDurationMinutes(startDate, endDate);
  
  // Format a duration
  const formattedDuration = formatDuration(90); // Returns "1:30"
  
  // Check if a date is today or yesterday
  const isDateToday = isToday('2025-03-10T14:30:00Z');
  const isDateYesterday = isYesterday('2025-03-10T14:30:00Z');
  
  return (
    <div>
      <p>Your timezone: {userTimezone}</p>
      <p>Formatted date and time: {formattedDate}</p>
      <p>Formatted time: {formattedTime}</p>
      <p>Formatted date: {formattedDateOnly}</p>
      <p>Duration: {minutes} minutes ({formattedDuration})</p>
      <p>Is today: {isDateToday ? 'Yes' : 'No'}</p>
      <p>Is yesterday: {isDateYesterday ? 'Yes' : 'No'}</p>
    </div>
  );
}
```

## API Reference

### Context Values

| Property | Type | Description |
|----------|------|-------------|
| `isLoading` | `boolean` | Whether the timezone context is still initializing |
| `userTimezone` | `string` | The user's detected timezone (e.g., 'America/Denver') |
| `isDST` | `boolean` | Whether DST is currently active in the user's timezone |
| `formatDate` | `(isoString: string \| null \| undefined, formatOptions?: Intl.DateTimeFormatOptions) => string` | Format an ISO date string in the user's timezone with specified format options |
| `formatTime` | `(isoString: string \| null \| undefined) => string` | Format a time-only representation of an ISO date string |
| `formatDateOnly` | `(isoString: string \| null \| undefined) => string` | Format a date-only representation of an ISO date string |
| `formatDateTime` | `(isoString: string \| null \| undefined) => string` | Format a date and time representation of an ISO date string |
| `calculateDurationMinutes` | `(startIsoString: string \| null \| undefined, endIsoString: string \| null \| undefined) => number` | Calculate the duration between two ISO date strings in minutes |
| `formatDuration` | `(minutes: number) => string` | Format a duration in minutes to a human-readable string (HH:MM) |
| `isToday` | `(isoString: string \| null \| undefined) => boolean` | Check if a date is today in the user's timezone |
| `isYesterday` | `(isoString: string \| null \| undefined) => boolean` | Check if a date is yesterday in the user's timezone |
| `isDaylightSavingTime` | `(date: Date, timezone: string) => boolean` | Check if a date is in DST for a specific timezone |
| `toLocalDate` | `(isoString: string \| null \| undefined) => Date \| null` | Convert a UTC ISO string to a Date object in the user's local timezone |
| `toUTCString` | `(date: Date \| null \| undefined) => string \| null` | Convert a local Date object to a UTC ISO string for storage in the database |
| `getCurrentUTCString` | `() => string` | Get the current date and time as a UTC ISO string |
| `refreshTimezone` | `() => void` | Force refresh the timezone information |

### `formatDate(isoString, formatOptions?)`

Formats an ISO date string in the user's timezone with specified format options.

**Parameters:**
- `isoString`: An ISO date string, or null/undefined
- `formatOptions`: Optional Intl.DateTimeFormatOptions object for customizing the format

**Returns:** A formatted date string in the user's timezone.

```typescript
const formattedDate = formatDate('2025-03-10T14:30:00Z', {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
});
// "Monday, March 10, 2025, 8:30 AM"
```

### `formatTime(isoString)`

Formats a time-only representation of an ISO date string in the user's timezone.

**Parameters:**
- `isoString`: An ISO date string, or null/undefined

**Returns:** A formatted time string in the user's timezone.

```typescript
const formattedTime = formatTime('2025-03-10T14:30:00Z');
// "8:30 AM"
```

### `formatDateOnly(isoString)`

Formats a date-only representation of an ISO date string in the user's timezone.

**Parameters:**
- `isoString`: An ISO date string, or null/undefined

**Returns:** A formatted date string in the user's timezone.

```typescript
const formattedDate = formatDateOnly('2025-03-10T14:30:00Z');
// "Mar 10, 2025"
```

### `formatDateTime(isoString)`

Formats a date and time representation of an ISO date string in the user's timezone.

**Parameters:**
- `isoString`: An ISO date string, or null/undefined

**Returns:** A formatted date and time string in the user's timezone.

```typescript
const formattedDateTime = formatDateTime('2025-03-10T14:30:00Z');
// "Mar 10, 2025, 8:30 AM"
```

### `calculateDurationMinutes(startIsoString, endIsoString)`

Calculates the duration between two ISO date strings in minutes.

**Parameters:**
- `startIsoString`: The start date as an ISO string, or null/undefined
- `endIsoString`: The end date as an ISO string, or null/undefined

**Returns:** The number of minutes between the two dates.

```typescript
const minutes = calculateDurationMinutes(
  '2025-03-10T01:30:00Z',
  '2025-03-10T03:30:00Z'
);
// Returns 120 minutes
```

### `formatDuration(minutes)`

Formats a duration in minutes to a human-readable string (HH:MM).

**Parameters:**
- `minutes`: The duration in minutes

**Returns:** A formatted duration string in HH:MM format.

```typescript
const formattedDuration = formatDuration(90);
// "1:30"
```

### `isToday(isoString)`

Checks if a date is today in the user's timezone.

**Parameters:**
- `isoString`: An ISO date string, or null/undefined

**Returns:** A boolean indicating whether the date is today.

```typescript
const isDateToday = isToday('2025-03-10T14:30:00Z');
// true or false depending on the current date
```

### `isYesterday(isoString)`

Checks if a date is yesterday in the user's timezone.

**Parameters:**
- `isoString`: An ISO date string, or null/undefined

**Returns:** A boolean indicating whether the date is yesterday.

```typescript
const isDateYesterday = isYesterday('2025-03-10T14:30:00Z');
// true or false depending on the current date
```

### `isDaylightSavingTime(date, timezone)`

Checks if a date is in Daylight Saving Time (DST) for a specific timezone.

**Parameters:**
- `date`: A Date object to check
- `timezone`: The timezone to check against (e.g., 'America/Denver')

**Returns:** A boolean indicating whether the date is in DST.

```typescript
const now = new Date();
const isDST = isDaylightSavingTime(now, 'America/Denver');
// true or false depending on whether DST is active
```

### `toLocalDate(isoString)`

Converts a UTC ISO string to a Date object in the user's local timezone. This is useful for working with dates from the database (which are stored in UTC). This function properly accounts for DST.

**Parameters:**
- `isoString`: An ISO date string, or null/undefined

**Returns:** A Date object in the user's local timezone, or null if the input is invalid.

```typescript
const localDate = toLocalDate('2025-03-10T14:30:00Z');
// Returns a Date object representing the time in the user's timezone
```

### `toUTCString(date)`

Converts a local Date object to a UTC ISO string for storage in the database.

**Parameters:**
- `date`: A Date object, or null/undefined

**Returns:** A UTC ISO string, or null if the input is invalid.

```typescript
const utcString = toUTCString(new Date());
// "2025-03-10T14:30:00.000Z"
```

### `isLoading`

A boolean indicating whether the timezone context is still initializing.

This is useful for components that need to wait for the timezone information to be available before rendering.

```typescript
const { isLoading, userTimezone } = useTimezone();

if (isLoading) {
  return <div>Loading timezone information...</div>;
}

return <div>Your timezone is {userTimezone}</div>;
```

### `isDST`

A boolean indicating whether DST is currently active in the user's timezone.

```typescript
const { isDST } = useTimezone();

return <div>DST is currently {isDST ? 'active' : 'inactive'} in your timezone</div>;
```

### `refreshTimezone()`

Forces a refresh of the timezone information. This is useful if you suspect the timezone information might have changed (e.g., if the user has changed their system timezone).

```typescript
const { refreshTimezone } = useTimezone();

// Force refresh the timezone information
refreshTimezone();
```

### `getCurrentUTCString()`

Gets the current date and time as a UTC ISO string.

**Returns:** A UTC ISO string representing the current time.

```typescript
const now = getCurrentUTCString();
// "2025-03-10T14:30:00.000Z"
```

## DST Handling

The timezone context is designed to handle Daylight Saving Time (DST) changes correctly. It provides several features for proper DST handling:

1. **DST Detection**: The `isDaylightSavingTime` function checks if a date is in DST for a specific timezone by examining the timezone name (looking for "Daylight" or "Summer").

2. **Automatic DST Handling in Formatting**: When formatting dates with `formatDate` and its variants, the context uses the `Intl.DateTimeFormat` API with the user's timezone, which automatically adjusts for DST.

3. **DST-Aware Duration Calculation**: The `calculateDurationMinutes` function calculates the duration between two dates by comparing their epoch timestamps, which ensures accurate duration calculations regardless of DST changes.

4. **DST-Aware Local Date Conversion**: The `toLocalDate` function converts UTC ISO strings to local Date objects, properly accounting for DST by using the `Intl.DateTimeFormat` API to extract date components in the user's timezone.

## Implementation Details

The context uses:
- Browser's `Intl.DateTimeFormat().resolvedOptions().timeZone` to detect the user's timezone
- JavaScript's `Intl.DateTimeFormat` API for formatting dates in the user's timezone and detecting DST
- Epoch timestamps for duration calculations, which automatically handle DST changes
- ISO strings for date serialization, ensuring consistent date handling across timezones
- Explicit DST detection for improved accuracy in date handling

## Working with UTC and Local Time

The Baby Tracker application follows these principles for timezone handling:

1. **Database Storage**: All dates are stored in UTC format in the database
2. **API Communication**: All dates are transmitted as ISO strings between client and server
3. **Display**: Dates are displayed in the user's local timezone

## Handling Loading State

The timezone context now includes an `isLoading` state that indicates whether the timezone information is still being initialized. This is useful for components that need to wait for the timezone information to be available before rendering.

```typescript
function MyComponent() {
  const { isLoading, formatDateTime } = useTimezone();
  
  // Show a loading indicator while timezone information is being initialized
  if (isLoading) {
    return <div>Loading timezone information...</div>;
  }
  
  // Once timezone information is available, render the component
  return (
    <div>
      <p>Current time: {formatDateTime(new Date().toISOString())}</p>
    </div>
  );
}
```

This ensures that components don't attempt to format dates or perform timezone-dependent operations until the timezone information is available, which helps prevent incorrect time displays during initialization.

To follow this pattern in your components:

1. When **reading** dates from the API:
   ```typescript
   // The API returns dates as ISO strings
   const feedTime = data.time; // "2025-03-10T14:30:00Z"
   
   // Format for display using the timezone context
   const displayTime = formatTime(feedTime); // "8:30 AM"
   ```

2. When **sending** dates to the API:
   ```typescript
   // Get the current time as a UTC ISO string
   const currentTime = getCurrentUTCString();
   
   // Or convert a local Date to a UTC ISO string
   const selectedDate = new Date(); // Local date from a date picker
   const utcString = toUTCString(selectedDate);
   
   // Send to the API
   await fetch('/api/feed-log', {
     method: 'POST',
     body: JSON.stringify({ time: utcString }),
   });
   ```

## Cross-Platform Considerations

This context is designed to work in both web and mobile environments:

- Uses standard JavaScript Date APIs that are available in React Native
- Avoids browser-specific APIs except for timezone detection
- For React Native, the timezone detection would need to be adapted to use the device's timezone

When converting to React Native, you would need to:
1. Replace `Intl.DateTimeFormat().resolvedOptions().timeZone` with a React Native equivalent
2. Keep the rest of the implementation largely the same
