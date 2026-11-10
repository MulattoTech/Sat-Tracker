# CalendarEvent Component

A versatile component for displaying calendar events in the Baby Tracker application. This component supports both standard and compact display modes, making it suitable for use in various contexts such as calendar views, lists, and notifications.

## Features

- Color-coded visual indicators based on event type
- Display of event title, time, and location
- Support for recurring events with visual indicator
- Badges showing associated babies, caretakers, and contacts
- Edit and delete action buttons
- Responsive design for mobile and desktop
- Dark mode support
- Compact mode for space-constrained contexts

## Usage

### Basic Usage

```tsx
import { CalendarEvent } from '@/src/components/CalendarEvent';

function EventDisplay({ event }) {
  return (
    <CalendarEvent 
      event={event}
      onClick={() => openEventDetails(event.id)}
    />
  );
}
```

### With Edit and Delete Actions

```tsx
import { CalendarEvent } from '@/src/components/CalendarEvent';

function EventWithActions({ event }) {
  const handleEdit = (event) => {
    // Open edit form
    openEditForm(event);
  };
  
  const handleDelete = (eventId) => {
    // Show confirmation dialog
    confirmDelete(eventId);
  };
  
  return (
    <CalendarEvent 
      event={event}
      onClick={() => openEventDetails(event.id)}
      onEdit={handleEdit}
      onDelete={handleDelete}
    />
  );
}
```

### Compact Mode

```tsx
import { CalendarEvent } from '@/src/components/CalendarEvent';

function CompactEventList({ events }) {
  return (
    <div className="space-y-2">
      {events.map(event => (
        <CalendarEvent 
          key={event.id}
          event={event}
          compact={true}
          onClick={() => openEventDetails(event.id)}
        />
      ))}
    </div>
  );
}
```

## Component API

### CalendarEvent

Main component for displaying a calendar event.

#### Props

| Prop | Type | Description | Default |
|------|------|-------------|---------|
| `event` | `CalendarEventData` | The calendar event data to display | Required |
| `onClick` | `(event: CalendarEventData) => void` | Handler for when the event is clicked | `undefined` |
| `onEdit` | `(event: CalendarEventData) => void` | Handler for the edit action | `undefined` |
| `onDelete` | `(eventId: string) => void` | Handler for the delete action | `undefined` |
| `compact` | `boolean` | Whether to use compact display mode | `false` |
| `className` | `string` | Additional CSS classes to apply | `undefined` |

### CalendarEventData

Interface representing a calendar event.

```typescript
interface CalendarEventData {
  id: string;
  title: string;
  description?: string;
  startTime: Date;
  endTime?: Date;
  allDay: boolean;
  type: CalendarEventType; // APPOINTMENT, CARETAKER_SCHEDULE, REMINDER, CUSTOM
  location?: string;
  color?: string;
  
  // Recurrence fields
  recurring: boolean;
  recurrencePattern?: RecurrencePattern; // DAILY, WEEKLY, BIWEEKLY, MONTHLY, YEARLY, CUSTOM
  recurrenceEnd?: Date;
  customRecurrence?: string;
  
  // Notification fields
  reminderTime?: number;
  notificationSent: boolean;
  
  // Related entities
  babies: Baby[];
  caretakers: Caretaker[];
  contacts: Contact[];
  
  // Metadata
  createdAt: Date;
  updatedAt: Date;
}
```

## Visual Behavior

- Displays a color-coded indicator based on event type
- Shows the event title, date, and time
- For non-compact mode:
  - Displays location if available
  - Shows description if available
  - Displays badges for associated babies, caretakers, and contacts
  - Shows edit and delete buttons if handlers are provided
- For compact mode:
  - Shows only title and time in a condensed format
  - Uses a vertical color indicator instead of horizontal

## Implementation Details

The component is built using:
- React with TypeScript for type safety
- Tailwind CSS for styling
- Lucide React for icons
- CSS modules for component-specific styles

The component follows a modular structure:
- `index.tsx` - Main component implementation
- `calendar-event.styles.ts` - Style definitions using Tailwind CSS
- `calendar-event.types.ts` - TypeScript type definitions
- `calendar-event.css` - Additional CSS for dark mode and animations

## Accessibility

The component includes:
- Proper semantic HTML structure
- ARIA labels for buttons
- Keyboard navigable interactive elements
- Color contrast that meets WCAG guidelines
- Focus states for interactive elements

## Cross-Platform Considerations

This component is designed with cross-platform compatibility in mind:

- Uses standard React patterns that can be adapted to React Native
- Avoids web-specific APIs
- Uses relative sizing that can be adapted to different screen sizes
- Implements touch-friendly button sizes
- Separates styling from component logic for easier platform adaptation

When converting to React Native, the styling would need to be adapted to use React Native's StyleSheet or a compatible styling solution like NativeWind. The component structure and logic would remain largely the same.
