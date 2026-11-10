# Baby Quick Stats Component

A form component that displays quick stats and information about the selected baby. This is currently a placeholder component that will be expanded with more functionality in future updates.

## Features

- Displays in a full-page form that slides in from the right
- Shows the baby's full name and age
- Color-coded based on baby's gender (blue for male, pink for female)
- Includes a close button to dismiss the form
- Placeholder for future quick stats content

## Usage

Import and use the component in your layout or page component:

```tsx
import { BabyQuickStats } from "@/src/components/forms/Baby-Quick-Stats";

export function MyComponent() {
  const { selectedBaby } = useBaby();
  const [quickStatsOpen, setQuickStatsOpen] = useState(false);

  // Function to calculate baby's age
  const calculateAge = (birthday: Date) => {
    // Age calculation logic
  };

  return (
    <>
      <Button onClick={() => setQuickStatsOpen(true)}>
        View Baby Stats
      </Button>
      
      <BabyQuickStats
        isOpen={quickStatsOpen}
        onClose={() => setQuickStatsOpen(false)}
        selectedBaby={selectedBaby}
        calculateAge={calculateAge}
      />
    </>
  );
}
```

## Implementation Details

The Baby Quick Stats component is built using:

- React functional component with TypeScript
- FormPage component from the project's UI library
- TailwindCSS for styling via utility functions

The component follows a modular structure:
- `index.tsx` - Main component implementation
- `baby-quick-stats.styles.ts` - Style definitions using TailwindCSS
- `baby-quick-stats.types.ts` - TypeScript type definitions
- `README.md` - Documentation

## Props

| Prop | Type | Description |
|------|------|-------------|
| `isOpen` | `boolean` | Whether the form is open |
| `onClose` | `() => void` | Function to call when the form should be closed |
| `selectedBaby` | `Baby \| null` | The currently selected baby |
| `calculateAge` | `(birthDate: Date) => string` | Optional function to calculate the age of a baby |

## Component Structure

The component uses the FormPage component from the UI library, which provides:

1. **Form Header** - Contains the title "Baby Quick Stats" and description
2. **Form Content** - Displays the baby's information and stats
3. **Form Footer** - Contains the close button

## Future Enhancements

This component is designed to be expanded in the future with additional functionality, such as:

- Displaying recent feeding, diaper, and sleep events
- Showing growth metrics and milestones
- Providing quick access to common actions like logging new events
- Displaying health information and upcoming appointments

## Mobile Considerations (React Native)

When adapting this component for React Native, consider the following:

- **Styling**: The TailwindCSS classes will need to be replaced with React Native's StyleSheet
- **Form Page**: Replace with a React Native Modal or custom slide-in component
- **Layout**: Ensure the layout is optimized for various mobile screen sizes
- **Scrolling**: Implement proper scrolling behavior for content that exceeds the screen height
