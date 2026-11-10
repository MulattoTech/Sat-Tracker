# DateTimePicker Component

A modern, accessible date and time picker component for the Baby Tracker application that combines a calendar for date selection and a touch-friendly time picker with swipe controls.

## Features

- Two separate buttons for date and time selection
- Calendar component for date selection in a popover
- iOS-style time picker with touch/swipe controls in a popover
- Automatic closing of date popover when a date is selected
- Time popover closes when clicking outside
- Fixed dimensions for consistent UI (360px height, 350px width)
- Bottom-aware positioning with margin
- Keyboard accessibility
- Dark mode support
- Consistent styling regardless of screen size
- Follows the project's design system

## Usage

```tsx
import { DateTimePicker } from '@/src/components/ui/date-time-picker';
import { useState } from 'react';

function DateTimePickerExample() {
  const [selectedDateTime, setSelectedDateTime] = useState(new Date());
  
  return (
    <div className="p-4">
      <h2 className="text-lg font-semibold mb-2">Select Date and Time</h2>
      <DateTimePicker 
        value={selectedDateTime} 
        onChange={setSelectedDateTime}
      />
    </div>
  );
}
```

## Component API

### DateTimePicker

Main component for selecting both date and time with a user-friendly interface.

#### Props

| Prop | Type | Description | Default |
|------|------|-------------|---------|
| `value` | `Date` | The currently selected date and time | Required |
| `onChange` | `(date: Date) => void` | Callback function when date/time changes | Required |
| `className` | `string \| undefined` | Optional class name for additional styling | `undefined` |
| `disabled` | `boolean` | Whether the component is disabled | `false` |
| `placeholder` | `string` | Placeholder text (legacy, not used in current implementation) | `"Select date and time..."` |

## Visual Behavior

- Displays two buttons side by side, one for date and one for time
- Each button shows an icon and the currently selected value
- Clicking the date button opens a calendar popover
- Clicking the time button opens a time picker popover
- Selecting a date automatically closes the calendar popover
- Time picker popover closes when clicking outside
- Both popovers have fixed dimensions for consistent UI
- Popovers are positioned with awareness of the bottom of the screen

## Implementation Details

The component combines several UI components:
1. Button components for triggering the date and time popovers
2. Popover components for displaying the selection interfaces
3. Calendar component for date selection
4. TimeEntry component for time selection with touch controls

The component handles:
- Maintaining internal state for the selected date/time
- Formatting the date and time for display in the buttons
- Preserving time when changing date and vice versa
- Proper focus management for accessibility
- Bottom-aware positioning of popovers

## Cross-Platform Considerations

This component is designed with cross-platform compatibility in mind:

- Uses standard React patterns that can be adapted to React Native
- Implements touch interactions that work on both mobile and desktop
- Uses fixed sizing that can be adapted to different screen sizes
- Handles time in a platform-agnostic way

When converting to React Native, the Calendar and TimeEntry components would need to be implemented using React Native's components and gesture system, but the overall structure and logic would remain similar.
