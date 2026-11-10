# CalendarEventItem Component

A compact, list-friendly component for displaying calendar events in the Baby Tracker application. This component is optimized for use in lists, summary views, and notifications.

## Features

- Streamlined display of event information
- Color-coded visual indicators based on event type
- Smart date formatting (Today, Tomorrow, or date)
- Compact time and location display
- Visual indicator for recurring events
- Participant count badge
- Responsive design for mobile and desktop
- Dark mode support
- Touch-friendly design

## Usage

### Basic Usage

```tsx
import { CalendarEventItem } from '@/src/components/CalendarEventItem';

function EventList({ events }) {
  return (
    <div className="space-y-2">
      {events.map(event => (
        <CalendarEventItem 
          key={event.id}
          event={event}
          onClick={() => openEventDetails(event.id)}
        />
      ))}
    </div>
  );
}
```

### In BabyQuickStats

```tsx
import { CalendarEventItem } from '@/src/components/CalendarEventItem';

function BabyQuickStats({ upcomingEvents }) {
  return (
    <div className="quick-stats-container">
      <h3 className="text-lg font-semibold">Upcoming Events</h3>
      
      {upcomingEvents.length > 0 ? (
        <div className="space-y-2 mt-2">
          {upcomingEvents.map(event => (
            <CalendarEventItem 
              key={event.id}
              event={event}
              onClick={() => openEventDetails(event.id)}
            />
          ))}
        </div>
      ) : (
        <p className="text-gray-500 dark:text-gray-400 mt-2">No upcoming events</p>
      )}
    </div>
  );
}
```

## Component API

### CalendarEventItem

Main component for displaying a calendar event in a compact format.

#### Props

| Prop | Type | Description | Default |
|------|------|-------------|---------|
| `event` | `CalendarEventData` | The calendar event data to display | Required |
| `onClick` | `(event: CalendarEventData) => void` | Handler for when the event is clicked | `undefined` |
| `className` | `string` | Additional CSS classes to apply | `undefined` |

## Visual Behavior

- Displays a vertical color-coded indicator based on event type
- Shows the event title with truncation for long titles
- Displays smart-formatted date and time (Today, Tomorrow, or date)
- Shows location if available
- Displays a recurring icon for recurring events
- Shows a participant count badge with the total number of babies, caretakers, and contacts

## Implementation Details

The component is built using:
- React with TypeScript for type safety
- Tailwind CSS for styling
- Lucide React for icons
- CSS modules for component-specific styles

The component follows a modular structure:
- `index.tsx` - Main component implementation
- `calendar-event-item.styles.ts` - Style definitions using Tailwind CSS
- `calendar-event-item.types.ts` - TypeScript type definitions
- `calendar-event-item.css` - Additional CSS for dark mode and animations

## Accessibility

The component includes:
- Proper semantic HTML structure
- Sufficient color contrast for text and background
- Touch-friendly sizing for mobile use
- Keyboard navigable interactive elements

## Cross-Platform Considerations

This component is designed with cross-platform compatibility in mind:

- Uses standard React patterns that can be adapted to React Native
- Avoids web-specific APIs
- Uses relative sizing that can be adapted to different screen sizes
- Implements touch-friendly dimensions
- Separates styling from component logic for easier platform adaptation

When converting to React Native, the styling would need to be adapted to use React Native's StyleSheet or a compatible styling solution like NativeWind. The component structure and logic would remain largely the same.

## Differences from CalendarEvent Component

The CalendarEventItem component is a simplified version of the CalendarEvent component:

- More compact layout optimized for lists
- Vertical color indicator instead of horizontal
- Smart date formatting (Today, Tomorrow)
- Simplified participant display with a count badge
- No edit/delete actions
- No description display
- Optimized for touch interaction in lists
