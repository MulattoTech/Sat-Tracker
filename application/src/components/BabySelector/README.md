# Baby Selector Component

A component that displays the currently selected baby and allows switching between babies via a dropdown menu. It also provides access to the baby's quick stats.

## Features

- Shows the currently selected baby's name and age
- Displays a moon icon if the baby is currently sleeping
- Provides a dropdown menu to switch between babies
- Separates the dropdown trigger from the main content
- Main content area opens the baby quick stats form when clicked
- Color-coded based on baby's gender (blue for male, pink for female)

## Usage

Import and use the component in your layout or page component:

```tsx
import { BabySelector } from "@/src/components/BabySelector";

export function MyComponent() {
  const { selectedBaby, setSelectedBaby, sleepingBabies } = useBaby();
  const [babies, setBabies] = useState<Baby[]>([]);
  const [quickStatsOpen, setQuickStatsOpen] = useState(false);

  // Function to calculate baby's age
  const calculateAge = (birthday: Date) => {
    // Age calculation logic
  };

  return (
    <>
      <BabySelector
        selectedBaby={selectedBaby}
        onBabySelect={setSelectedBaby}
        babies={babies}
        sleepingBabies={sleepingBabies}
        calculateAge={calculateAge}
        onOpenQuickStats={() => setQuickStatsOpen(true)}
      />
      
      {/* Baby Quick Stats form would go here */}
    </>
  );
}
```

## Implementation Details

The Baby Selector component is built using:

- React functional component with TypeScript
- Lucide React for icons (Moon, ChevronDown)
- TailwindCSS for styling via utility functions
- UI components from the project's component library

The component follows a modular structure:
- `index.tsx` - Main component implementation
- `baby-selector.styles.ts` - Style definitions using TailwindCSS
- `baby-selector.types.ts` - TypeScript type definitions
- `README.md` - Documentation

## Props

| Prop | Type | Description |
|------|------|-------------|
| `selectedBaby` | `Baby \| null` | The currently selected baby |
| `onBabySelect` | `(baby: Baby) => void` | Function to call when a baby is selected |
| `babies` | `Baby[]` | List of available babies |
| `sleepingBabies` | `Set<string>` | Set of baby IDs that are currently sleeping |
| `calculateAge` | `(birthDate: Date) => string` | Function to calculate the age of a baby |
| `onOpenQuickStats` | `() => void` | Function to open the baby quick stats form |

## Component Structure

The component is divided into two main sections:

1. **Baby Info Section** - Displays the baby's name, sleeping status, and age. Clicking on this section opens the baby quick stats form.
2. **Dropdown Button** - A circular button containing a chevron icon that triggers the dropdown menu for baby selection.

## Mobile Considerations (React Native)

When adapting this component for React Native, consider the following:

- **Styling**: The TailwindCSS classes will need to be replaced with React Native's StyleSheet
- **Dropdown Menu**: Replace with React Native's modal or a custom dropdown implementation
- **Touch Handling**: Ensure touch targets are appropriately sized for mobile interaction
- **Icons**: Replace Lucide React icons with React Native compatible icons
