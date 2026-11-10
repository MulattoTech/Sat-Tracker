# Status Bubble Component

A dynamic status indicator component designed for tracking baby activities. This component displays the current status (sleeping, awake, feeding, or diaper change) along with the duration, and includes warning states for extended durations. The component handles timezone differences and Daylight Saving Time (DST) changes correctly to ensure accurate duration calculations.

## Usage

```tsx
import { StatusBubble } from "@/src/components/ui/status-bubble";

export function BabyStatus() {
  return (
    <div className="relative">
      {/* Basic usage */}
      <StatusBubble 
        status="sleeping" 
        durationInMinutes={120} 
      />

      {/* With warning time */}
      <StatusBubble 
        status="feed" 
        durationInMinutes={180}
        warningTime="2:30" // Warns after 2 hours and 30 minutes
      />
    </div>
  );
}
```

## Props

### StatusBubbleProps

| Prop | Type | Description |
|------|------|-------------|
| `status` | `'sleeping' \| 'awake' \| 'feed' \| 'diaper'` | Current status of the baby |
| `durationInMinutes` | `number` | Duration in minutes for the current status |
| `warningTime?` | `string` | Optional warning threshold time in "hh:mm" format |
| `className?` | `string` | Additional CSS classes |

## Status Types

### Sleeping
- Gray background with white text
- Moon icon
- No warning state

### Awake
- Light blue background with dark text
- Sun icon with amber color
- No warning state

### Feed
- Green background normally
- Red background when exceeding warning time
- Bottle icon
- Supports warning threshold

### Diaper
- Green background normally
- Red background when exceeding warning time
- Diaper icon
- Supports warning threshold

## Styling

The component uses TailwindCSS with a modern, clean design:

### Base Styles
- Absolute positioning (top-right)
- Rounded bottom-left corner
- Semi-transparent backgrounds
- Consistent padding and spacing
- Flexible width based on content
- High z-index for overlay positioning

### Status-Specific Styles
- Color-coded backgrounds for different states
- Consistent icon sizing
- Clear text contrast
- Smooth transitions between states

## Features

1. **Duration Formatting**
   - Automatically formats minutes into "HH:MM" display
   - Handles any duration length
   - Zero-padded minutes for consistent display

2. **Warning System**
   - Optional warning threshold
   - Visual feedback for exceeded durations
   - Easy to customize warning times

3. **Accessibility**
   - High contrast color combinations
   - Clear visual indicators
   - Semantic HTML structure

## Best Practices

1. **Positioning**
   - Place within a relative-positioned container
   - Consider z-index when overlaying other content
   - Maintain sufficient spacing for touch targets

2. **Warning Times**
   - Set appropriate thresholds for each activity type
   - Use consistent warning times across the application
   - Document warning thresholds for team reference

3. **Mobile Considerations**
   - Touch-friendly target sizes
   - Clear visibility on small screens
   - Proper contrast in various lighting conditions

## Examples

### Basic Status Display
```tsx
<StatusBubble 
  status="sleeping" 
  durationInMinutes={45} 
/>
```

### With Warning Time
```tsx
<StatusBubble 
  status="feed" 
  durationInMinutes={150}
  warningTime="2:00" // Warning after 2 hours
/>
```

### Custom Positioning
```tsx
<StatusBubble 
  status="diaper" 
  durationInMinutes={30}
  className="top-2 right-2" // Override default positioning
/>
```

### Within a Card
```tsx
<div className="relative bg-white p-4 rounded-xl">
  <h3>Baby Status</h3>
  <StatusBubble 
    status="awake" 
    durationInMinutes={60} 
  />
</div>
```

## Integration Tips

1. **State Management**
   - Track durations using a timer system
   - Update durations regularly
   - Handle status changes appropriately

2. **Data Flow**
   - Consider using React Context for global status
   - Implement proper prop drilling alternatives
   - Maintain single source of truth

3. **Error Handling**
   - Validate duration inputs
   - Handle invalid warning time formats
   - Provide fallbacks for missing data

## Performance Considerations

- Memoize status style calculations if needed
- Optimize icon imports
- Handle frequent duration updates efficiently

## Timezone Handling

The StatusBubble component includes robust timezone handling to ensure accurate duration calculations, especially during Daylight Saving Time (DST) changes:

### DST-Aware Duration Calculation

When calculating the duration between a start time and the current time, the component:

1. Uses the `getMinutesBetweenDates` function from the timezone context
2. Compares timezone offsets at the start and end times
3. Adjusts for any offset differences (typically 1 hour during DST changes)
4. Ensures accurate duration display regardless of timezone changes

### Using with Start Times

For real-time duration tracking, you can provide a `startTime` prop instead of a fixed `durationInMinutes`:

```tsx
<StatusBubble 
  status="sleeping" 
  durationInMinutes={0} // Fallback value
  startTime={sleepStartTime.toISOString()}
/>
```

When `startTime` is provided, the component:
- Calculates the duration dynamically based on the current time
- Updates the duration every minute
- Handles DST changes correctly
- Falls back to the provided `durationInMinutes` if calculation fails

### Implementation Details

The component uses:
- The timezone context to access timezone information and utilities
- JavaScript's `getTimezoneOffset()` method to detect DST changes
- A useEffect hook with a setInterval to update the duration in real-time
- Error handling to provide fallbacks if calculations fail

This approach ensures that durations are displayed correctly even when:
- The user travels between timezones
- DST changes occur during an activity
- The server and client are in different timezones
