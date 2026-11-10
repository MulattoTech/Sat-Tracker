# ActivityTile Component

A modular, reusable component for displaying activity entries in the Baby Tracker application. The component can be used in two modes: as a regular tile in a timeline view or as a button for activity selection.

## Features

- Displays different types of activities (sleep, feed, diaper, note) with appropriate styling
- Supports two display modes: timeline entry or interactive button
- Interactive hover effects with icon scaling
- Customizable through props
- Follows the project's UI component patterns
- Designed for cross-platform compatibility

## Usage

### Basic Timeline Usage

```tsx
import { ActivityTile } from '@/src/components/ui/activity-tile';
import { SleepLogResponse } from '@/app/api/types';

// Example with a sleep activity
const sleepActivity: SleepLogResponse = {
  id: '1',
  babyId: 'baby1',
  startTime: '2025-03-07T14:30:00',
  endTime: '2025-03-07T16:00:00',
  duration: 90,
  type: 'NAP',
  location: 'Crib',
  quality: 'GOOD'
};

// Basic usage
<ActivityTile
  activity={sleepActivity}
  onClick={() => handleActivityClick(sleepActivity)}
/>

// With custom title and description
<ActivityTile
  activity={sleepActivity}
  title="Custom Title"
  description="Custom description text"
  onClick={() => handleActivityClick(sleepActivity)}
/>
```

### Button Mode Usage

```tsx
// Using as a button for activity selection
<ActivityTile
  activity={sleepActivity}
  isButton={true}
  title="Start Sleep"
  onClick={() => openSleepModal()}
/>
```

### In Timeline Implementation

As seen in the full-log page implementation, the ActivityTile is typically used within a timeline component:

```tsx
// Inside a timeline component
{activities.map((activity) => (
  <ActivityTile
    key={activity.id}
    activity={activity}
    onClick={() => handleActivityClick(activity)}
  />
))}
```

## Component API

### ActivityTile

Main component for displaying an activity.

#### Props

| Prop | Type | Description | Default |
|------|------|-------------|---------|
| `activity` | `ActivityType` | The activity data to display | Required |
| `onClick` | `() => void` | Callback when the activity tile is clicked | `undefined` |
| `icon` | `ReactNode` | Custom icon to display | Auto-generated based on activity type |
| `title` | `string` | Custom title to display | Auto-generated based on activity type |
| `description` | `string` | Custom description to display | Auto-generated based on activity type |
| `variant` | `'sleep' \| 'feed' \| 'diaper' \| 'note' \| 'default'` | Override the default styling | Auto-detected from activity |
| `className` | `string` | Additional CSS classes | `undefined` |
| `isButton` | `boolean` | Whether to render as a button with simplified layout | `false` |

### ActivityTileIcon

Sub-component for displaying the activity icon.

#### Props

| Prop | Type | Description | Default |
|------|------|-------------|---------|
| `activity` | `ActivityType` | The activity data to determine the icon | Required |
| `className` | `string` | Additional CSS classes | `undefined` |
| `variant` | `ActivityTileVariant` | The variant to use for styling | Auto-detected from activity |
| `isButton` | `boolean` | Whether the parent is in button mode | `false` |

### ActivityTileContent

Sub-component for displaying the activity content.

#### Props

| Prop | Type | Description | Default |
|------|------|-------------|---------|
| `activity` | `ActivityType` | The activity data to display | Required |
| `title` | `string` | Custom title to display | Auto-generated based on activity type |
| `description` | `string` | Custom description to display | Auto-generated based on activity type |
| `className` | `string` | Additional CSS classes | `undefined` |

## Visual Behavior

### Timeline Mode
- Displays the activity with an icon on the left and content (title/description) on the right
- Icon has a colored background based on activity type
- Hover effect slightly changes the background color

### Button Mode
- Displays as a colored button with an icon in the center
- Has a title label at the bottom
- The button background color matches the activity type
- On hover, only the icon scales to 110% of its size
- The icon container is transparent, allowing the button background to show through

## Styling

The component uses a combination of TailwindCSS classes defined in `activity-tile.styles.ts`:

```typescript
export const activityTileStyles = {
  base: "group transition-colors duration-200 cursor-pointer",
  container: "flex items-center justify-center px-6 py-3 overflow-hidden",
  
  // Button styles for each variant
  button: {
    base: "h-20 relative cursor-pointer",
    variants: {
      sleep: "bg-gradient-to-br from-gray-400 via-gray-500 to-gray-600 text-white border-r border-white",
      feed: "bg-[#B8E6FE] text-white",
      diaper: "bg-gradient-to-r from-teal-600 to-teal-700 text-white border-l border-white",
      note: "bg-[#FFFF99] text-white border-l border-white",
      default: "bg-gray-100 text-white"
    }
  },
  
  // Icon container styles
  iconContainer: {
    base: "flex-shrink-0 p-2 rounded-xl items-center justify-center transition-transform duration-200 group-hover:scale-110 overflow-hidden",
    variants: {
      sleep: "bg-transparent",
      feed: "bg-transparent",
      diaper: "bg-transparent",
      note: "bg-transparent",
      default: "bg-transparent"
    }
  },
  
  // Icon styles and default icons
  icon: {
    base: "h-4 w-4",
    variants: { /* color variations */ },
    defaultIcons: {
      sleep: "/crib-256.png",
      feed: "/bottle-256.png",
      diaper: "/diaper-256.png",
      note: "/notepad-256.png",
      default: ""
    }
  },
  
  // Content styles
  content: { /* content styling */ }
}
```

## Types

```typescript
type ActivityType = SleepLogResponse | FeedLogResponse | DiaperLogResponse | MoodLogResponse | NoteResponse;
type ActivityTileVariant = 'sleep' | 'feed' | 'diaper' | 'note' | 'default';
```

## Adding New Activity Types

To add a new activity type:

1. Update the `ActivityType` union type to include the new activity response type
2. Add a new variant to `ActivityTileVariant`
3. Update the `getActivityVariant` utility function to detect the new activity type
4. Add styling for the new variant in `activityTileStyles`
5. Add a default icon for the new variant in `styles.icon.defaultIcons`
6. Update the icon selection logic in `ActivityTileIcon` component
