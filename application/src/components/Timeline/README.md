# Timeline Component

The Timeline component is a comprehensive activity tracking interface that displays and manages various baby activities like sleep, feeding, diaper changes, baths, and notes. It provides filtering, pagination, and detailed views of each activity.

## Component Structure

The Timeline component is organized into several sub-components:

1. **index.tsx** - Main Timeline component that composes all sub-components and manages shared state
2. **TimelineFilter.tsx** - Handles date selection and activity type filtering
3. **TimelineActivityList.tsx** - Displays the list of activities with pagination
4. **TimelineActivityDetails.tsx** - Shows detailed view of a selected activity
5. **utils.tsx** - Contains utility functions for formatting and processing activities
6. **types.ts** - Contains shared type definitions

## Data Flow

```
index.tsx (Main Component)
├── TimelineFilter.tsx (Date & Activity Type Filtering)
├── DailyStats (Summary Statistics)
├── TimelineActivityList.tsx (Activity Display & Pagination)
└── TimelineActivityDetails.tsx (Activity Details & Actions)
```

## Features

- **Date Selection**: Navigate between days to view activities for specific dates
- **Activity Filtering**: Filter activities by type (sleep, feed, diaper, bath, note)
- **Daily Statistics**: View summary statistics for the selected day
- **Activity List**: Scrollable list of activities with visual indicators
- **Pagination**: Control how many activities to display per page
- **Activity Details**: View detailed information about selected activities
- **Edit & Delete**: Modify or remove activities as needed

## How to Use

### Basic Usage

```tsx
import Timeline from '@/src/components/Timeline';

const MyComponent = () => {
  // Initial activities (optional, the component will fetch activities for the current date)
  const activities = [];
  
  // Callback when an activity is deleted or date is changed
  const handleActivityDeleted = (dateFilter?: Date) => {
    // Handle refresh or update logic
  };
  
  return (
    <Timeline 
      activities={activities} 
      onActivityDeleted={handleActivityDeleted} 
    />
  );
};
```

## Adding New Activities

To add support for a new activity type in the Timeline component, follow these steps:

1. **Update Types**:
   - Add the new activity type to the `FilterType` in `types.ts`
   - Ensure the activity data structure is compatible with `ActivityType`

2. **Update Utility Functions**:
   - Add handling for the new activity type in `getActivityIcon`
   - Add formatting logic in `getActivityDetails` and `getActivityDescription`
   - Add styling in `getActivityStyle`
   - Add API endpoint mapping in `getActivityEndpoint`

3. **Update Filter Component**:
   - Add a new filter button in `TimelineFilter.tsx` with appropriate icon

4. **Update Activity Filtering**:
   - Add a case for the new activity type in the filter logic in `index.tsx`

5. **Create Form Component**:
   - Create a form component for adding/editing the new activity type
   - Add the form to the edit forms section in `index.tsx`

### Example: Adding a "Growth" Activity Type

1. **Update Types**:

```tsx
// In types.ts
export type FilterType = 'sleep' | 'feed' | 'diaper' | 'note' | 'bath' | 'growth' | null;

// Ensure your growth activity type is compatible with ActivityType
// For example, it might have properties like height, weight, headCircumference
```

2. **Update Utility Functions**:

```tsx
// In utils.tsx
export const getActivityIcon = (activity: ActivityType) => {
  // Existing code...
  
  if ('height' in activity || 'weight' in activity) {
    return <RulerIcon className="h-4 w-4 text-white" />; // Growth activity
  }
  
  // Rest of the function...
};

// Add similar updates to other utility functions
```

3. **Update Filter Component**:

```tsx
// In TimelineFilter.tsx
<FilterButton 
  type="growth" 
  activeFilter={activeFilter} 
  onFilterChange={onFilterChange}
  icon={<RulerIcon className="h-4 w-4" />}
/>
```

4. **Update Activity Filtering**:

```tsx
// In index.tsx, update the filter logic
const filtered = !activeFilter
  ? dateFilteredActivities
  : dateFilteredActivities.filter(activity => {
      switch (activeFilter) {
        // Existing cases...
        case 'growth':
          return 'height' in activity || 'weight' in activity;
        default:
          return true;
      }
    });
```

5. **Create Form Component**:

```tsx
// Create a GrowthForm component similar to other form components
// Then add it to the edit forms section in index.tsx
<GrowthForm
  isOpen={editModalType === 'growth'}
  onClose={() => {
    setEditModalType(null);
    setSelectedActivity(null);
  }}
  babyId={selectedActivity.babyId}
  initialTime={getActivityTime(selectedActivity)}
  activity={'height' in selectedActivity || 'weight' in selectedActivity ? selectedActivity : undefined}
  onSuccess={() => {
    setEditModalType(null);
    setSelectedActivity(null);
    onActivityDeleted?.();
  }}
/>
```

## API Integration

The Timeline component integrates with the following API endpoints:

- `/api/timeline` - Fetch activities for a specific date
- `/api/settings` - Fetch user settings
- `/api/sleep-log` - Manage sleep activities
- `/api/feed-log` - Manage feeding activities
- `/api/diaper-log` - Manage diaper change activities
- `/api/note` - Manage notes
- `/api/bath-log` - Manage bath activities

## Customization

The Timeline component can be customized by:

- Modifying the styling in each component
- Adjusting the filter options in TimelineFilter
- Changing the activity display format in TimelineActivityList
- Updating the details display in TimelineActivityDetails
