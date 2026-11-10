# Changelog Modal Component

A modal component that displays the application's changelog in a formatted way, rendering markdown content.

## Features

- Displays the application's changelog from markdown content
- Supports both light and dark mode
- Highlights specific versions when requested
- Responsive design with scrollable content
- Accessible with keyboard navigation support

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `open` | `boolean` | `required` | Whether the modal is open |
| `onClose` | `() => void` | `required` | Callback function to close the modal |
| `version` | `string` | `undefined` | Optional version to highlight in the changelog |

## Usage Examples

### Basic Usage

```tsx
import { ChangelogModal } from "@/src/components/modals/changelog";
import { useState } from "react";

export function MyComponent() {
  const [isOpen, setIsOpen] = useState(false);
  
  return (
    <>
      <button onClick={() => setIsOpen(true)}>
        View Changelog
      </button>
      
      <ChangelogModal 
        open={isOpen} 
        onClose={() => setIsOpen(false)} 
      />
    </>
  )
}
```

### With Specific Version Highlighted

```tsx
import { ChangelogModal } from "@/src/components/modals/changelog";
import { useState } from "react";

export function MyComponent() {
  const [isOpen, setIsOpen] = useState(false);
  
  return (
    <>
      <button onClick={() => setIsOpen(true)}>
        View Changelog for v0.9.0
      </button>
      
      <ChangelogModal 
        open={isOpen} 
        onClose={() => setIsOpen(false)}
        version="0.9.0"
      />
    </>
  )
}
```

## Implementation Details

The Changelog Modal component is built using:

- React's `useEffect` for fetching the changelog content
- Next.js's `Dialog` component for the modal functionality
- `react-markdown` for rendering the markdown content
- TailwindCSS for styling with dark mode support

The component follows a modular structure:
- `index.tsx` - Main component implementation
- `changelog-modal.styles.ts` - Style definitions
- `changelog-modal.types.ts` - TypeScript type definitions
- `changelog-modal.css` - Dark mode style overrides

## Accessibility

The Changelog Modal includes:
- Proper focus management
- Keyboard navigation support (Escape to close)
- Semantic HTML structure
- Appropriate ARIA attributes

## Mobile Considerations (React Native)

When adapting this component for React Native, consider the following:

- Replace the Dialog component with a React Native Modal
- Use a React Native markdown renderer like `react-native-markdown-display`
- Implement custom scrolling behavior for the content
- Adapt the styling to use React Native's StyleSheet
