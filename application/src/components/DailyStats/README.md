# DailyStats Component

The DailyStats component displays a summary of baby activities for a specific day, including sleep time, feeding information, diaper changes, and other tracked activities.

## Features

- Collapsible interface that expands to show detailed statistics
- Animated ticker that displays key stats in a compact format when collapsed
- Responsive grid layout that adapts to different screen sizes
- Support for both light and dark modes
- Loading and empty states

## Usage

```tsx
import DailyStats from '@/src/components/DailyStats';

// Example usage in a component
const MyComponent = () => {
  const [activities, setActivities] = useState<ActivityType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const selectedDate = new Date();

  // Fetch activities
  useEffect(() => {
    // Fetch activities for the selected date
    // ...
  }, [selectedDate]);

  return (
    <DailyStats
      activities={activities}
      date={selectedDate}
      isLoading={isLoading}
    />
  );
};
```

## Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `activities` | `ActivityType[]` | Yes | List of activities to display statistics for |
| `date` | `Date` | Yes | Date for which to display statistics |
| `isLoading` | `boolean` | No | Whether the component is in a loading state |

## Implementation Details

The component calculates various statistics from the provided activities:
- Total sleep and awake time
- Feeding amounts (bottle, breast, solids)
- Diaper changes and poop count
- Number of notes and other activities

The component is structured with two main views:
1. **Collapsed view**: Shows a date header and a scrolling ticker with key stats
2. **Expanded view**: Shows a grid of detailed statistics with icons

## Styling

The component uses Tailwind CSS for styling with custom CSS for dark mode support. Styles are organized following the project's pattern:
- `daily-stats.styles.ts`: Contains Tailwind classes
- `daily-stats.css`: Contains dark mode overrides and animations
- `daily-stats.types.ts`: Contains TypeScript interfaces for the component

## Accessibility

- Uses semantic HTML elements
- Provides clear visual indicators for interactive elements
- Maintains sufficient color contrast in both light and dark modes
