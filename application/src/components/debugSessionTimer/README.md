# Debug Session Timer Component

A draggable debug timer that displays JWT token expiration and user idle time. This component is only visible in development mode and helps developers monitor authentication state and user activity.

## Features

- Shows JWT token expiration countdown in hours:minutes:seconds
- Displays user idle time in minutes:seconds
- Draggable interface that can be positioned anywhere on screen
- Close button to dismiss the timer
- Only appears in development mode
- Resets idle counter on user activity (mouse, keyboard, touch)
- Automatically extracts expiration time from JWT token in localStorage

## Usage

Simply import and include the component in your layout or page component:

```tsx
import { DebugSessionTimer } from "@/src/components/debugSessionTimer";

export function MyLayout({ children }) {
  return (
    <>
      {children}
      <DebugSessionTimer />
    </>
  );
}
```

## Implementation Details

The Debug Session Timer component is built using:

- React's `useState`, `useEffect`, and `useRef` hooks for state management
- TypeScript for type safety
- TailwindCSS for styling
- Lucide React for icons

The component follows a modular structure:
- `index.tsx` - Main component implementation
- `debug-session-timer.styles.ts` - Style definitions using TailwindCSS
- `debug-session-timer.types.ts` - TypeScript type definitions

## Development Mode Only

This component is designed to only appear in development environments. It checks `process.env.NODE_ENV` and only renders when it equals `'development'`. This ensures it won't appear in production builds.

## JWT Token Parsing

The component parses the JWT token from localStorage to extract the expiration time:

1. Retrieves the token from `localStorage.getItem('authToken')`
2. Splits the token to get the payload section
3. Base64 decodes the payload
4. Extracts the `exp` field which contains the expiration timestamp
5. Converts the timestamp to a JavaScript Date object

## Idle Time Tracking

The component tracks user idle time by:

1. Storing the timestamp of the last user activity
2. Calculating the difference between current time and last activity
3. Resetting the counter when user activity is detected
4. Listening for mouse, keyboard, and touch events

## Draggable Interface

The draggable functionality is implemented using:

1. Mouse event listeners (mousedown, mousemove, mouseup)
2. Position state tracking with x/y coordinates
3. Offset calculation to ensure smooth dragging
4. Boundary checking to keep the timer within the viewport

## Mobile Considerations (React Native)

When adapting this component for React Native, consider the following:

- **Styling**: The TailwindCSS classes will need to be replaced with React Native's StyleSheet
- **Dragging**: The drag implementation will need to use React Native's PanResponder
- **Environment Detection**: Use React Native's platform-specific methods to detect development mode
- **localStorage**: Replace with AsyncStorage or another storage solution
- **Window Events**: Replace with React Native's touch and keyboard events
- **DOM Refs**: Replace with React Native refs
