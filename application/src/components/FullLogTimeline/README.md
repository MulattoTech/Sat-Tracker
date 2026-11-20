# FullLogTimeline Component

A comprehensive timeline component that displays activities over a date range with filtering and pagination capabilities.

## Features

- Date range selection using the Calendar component
- Activity filtering by type (sleep, feed, diaper, note, bath, pump, milestone, measurement)
- Quick date range filters (2 days, 7 days, 30 days)
- Pagination controls for viewing large sets of activities
- Activity details view with edit and delete functionality
- Dark mode support with consistent styling
- Selected-range CSV, XLSX and PDF export with the active activity-type filter

## Selected export

`FullLogExportButton` sends the current child, date range, activity-type filter,
timezone and language to the authorized timeline export route. The screen's
free-text search is not an export filter. All three formats include labeled rash
observations and caregiver details. Failed exports show an inline error and can
be retried.

CSV protects leading spreadsheet formula markers. XLSX uses string cells. The
PDF's internal JSON request returns those same authorized localized rows;
`activity-pdf.ts` inserts text nodes, paginates full fields without discarding
overflow, captures one page at a time with the existing html2canvas/jsPDF
dependencies, and removes its temporary DOM in `finally`. It produces a visual
PDF of page images; use CSV/XLSX for selectable data. `activity-pdf.css` fixes the
print layout independently of the device viewport and app theme.

## Usage

```tsx
import FullLogTimeline from '@/src/components/FullLogTimeline';

// Basic usage
const MyComponent = () => {
  const [activities, setActivities] = useState([]);
  const [startDate, setStartDate] = useState(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)); // 7 days ago
  const [endDate, setEndDate] = useState(new Date()); // Today
  
  const handleDateRangeChange = (newStartDate, newEndDate) => {
    setStartDate(newStartDate);
    setEndDate(newEndDate);
    // Fetch activities for the new date range
    fetchActivities(newStartDate, newEndDate);
  };
  
  const handleActivityDeleted = () => {
    // Refresh activities after deletion
    fetchActivities(startDate, endDate);
  };
  
  return (
    <FullLogTimeline
      activities={activities}
      onActivityDeleted={handleActivityDeleted}
      startDate={startDate}
      endDate={endDate}
      onDateRangeChange={handleDateRangeChange}
    />
  );
};
```

## Props

| Prop | Type | Description |
|------|------|-------------|
| `activities` | `ActivityType[]` | Array of activities to display |
| `onActivityDeleted` | `() => void` | Callback function when an activity is deleted |
| `startDate` | `Date` | Start date for the date range |
| `endDate` | `Date` | End date for the date range |
| `onDateRangeChange` | `(startDate: Date, endDate: Date) => void` | Callback function when the date range changes |

## Component Structure

The FullLogTimeline component is organized into several sub-components:

1. **index.tsx** - Main component that composes all sub-components and manages shared state
2. **FullLogFilter.tsx** - Handles date range selection and activity type filtering
3. **FullLogActivityList.tsx** - Displays the list of activities with pagination
4. **FullLogActivityDetails.tsx** - Shows detailed view of a selected activity
5. **full-log-timeline.types.ts** - Contains shared type definitions
6. **full-log-timeline.styles.ts** - Contains style definitions using TailwindCSS
7. **full-log-timeline.css** - Contains dark mode style overrides

## Implementation Details

The FullLogTimeline component is built using:

- React functional components with TypeScript
- TailwindCSS for styling via utility functions
- Class Variance Authority (CVA) for style variants
- Lucide React for icons
- React hooks and the existing authenticated fetch flow

## Dark Mode Support

The component includes built-in dark mode support:

1. **Styling Approach**: Uses a hybrid approach with:
   - TailwindCSS classes in the styles definition
   - Component-specific CSS overrides in `full-log-timeline.css` for consistent dark mode appearance
2. **Theme Context**: Integrates with the application's theme context to maintain theme state

## Mobile Considerations (React Native)

When adapting this component for React Native, consider the following:

- Replace TailwindCSS classes with React Native StyleSheet
- Use React Native's FlatList instead of div for the activity list
- Implement custom date handling for React Native
- Adjust styling to match React Native's layout system
- Implement theme switching using React Native's appearance API or a custom theme context
