# Timezone Debug Component

A utility component for debugging timezone-related issues in the Baby Tracker application. This component provides a floating button that, when clicked, displays detailed timezone information to help diagnose timezone and DST-related problems.

## Features

- Floating button that expands to show timezone information
- Displays user's detected timezone
- Shows server timezone
- Provides current time in ISO format
- Shows timezone offset in minutes
- Detects if the user is on a mobile device
- Displays browser user agent information
- Includes a refresh button to update the information

## Usage

The TimezoneDebug component is automatically included in the application's layout and is available on all pages:

```tsx
// app/layout.tsx
import { TimezoneDebug } from '@/src/components/debugTimezone';

function AppContent({ children }: { children: React.ReactNode }) {
  // ...
  return (
    <>
      {/* Other components */}
      <TimezoneDebug />
    </>
  );
}
```

## Component API

The TimezoneDebug component doesn't accept any props. It uses the useTimezone hook internally to access timezone information.

## Implementation Details

The component uses:
- React's useState hook to manage the expanded/collapsed state
- The useTimezone hook to access timezone information
- Browser's navigator.userAgent to detect mobile devices
- TailwindCSS for styling

## Mobile vs. Desktop Behavior

The component detects whether the user is on a mobile device and displays this information. This is particularly useful for debugging timezone issues that may behave differently on mobile devices compared to desktop browsers.

## Debugging Process

When troubleshooting timezone issues:

1. Click the "TZ" button in the bottom-right corner of the screen
2. Review the displayed timezone information
3. Note any discrepancies between user timezone and server timezone
4. Check if the device is correctly identified as mobile or desktop
5. Use the "Refresh Info" button to update the information if needed
6. Compare the timezone offset with what you expect for the current timezone

## Example Output

```
User Timezone: America/Denver
Server Timezone: America/Chicago
Current Time: 2025-03-18T18:30:00.000Z
Timezone Offset: 360 minutes
Is Mobile: Yes
Browser Info: Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1
```

## Security Considerations

This component is intended for debugging purposes only and should be disabled or removed in production environments, as it exposes information about the user's browser and system.
