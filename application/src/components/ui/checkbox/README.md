# Checkbox Component

A custom checkbox component with a styled appearance that follows the application's design system.

## Features

- Custom styled checkbox with consistent appearance
- Support for checked/unchecked states
- Keyboard accessibility
- Focus states for better UX
- Customizable through className prop

## Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `checked` | boolean | No | The checked state of the checkbox |
| `onCheckedChange` | (checked: boolean) => void | No | Callback function called when the checked state changes |
| `className` | string | No | Additional CSS classes to apply to the checkbox |
| `...props` | InputHTMLAttributes<HTMLInputElement> | No | All standard input props are supported |

## Usage

```tsx
import { Checkbox } from '@/src/components/ui/checkbox';
import { useState } from 'react';

function MyComponent() {
  const [checked, setChecked] = useState(false);
  
  return (
    <div className="flex items-center space-x-2">
      <Checkbox 
        id="terms" 
        checked={checked} 
        onCheckedChange={setChecked} 
      />
      <label 
        htmlFor="terms" 
        className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
      >
        Accept terms and conditions
      </label>
    </div>
  );
}
```

## Accessibility

- Uses a visually hidden native checkbox input for screen readers
- Supports keyboard navigation and focus states
- Includes proper ARIA attributes
- Maintains proper focus indication

## Styling

The component uses TailwindCSS for styling with the following features:

- Orange accent color for the checked state to match the application theme
- Smooth transition animations
- Focus ring for keyboard navigation
- Proper sizing for touch targets

## Implementation Details

- Uses React.forwardRef to allow ref forwarding
- Implements a custom onChange handler to normalize the checked state
- Uses a hidden native checkbox for accessibility
- Renders a custom styled div with a check icon for visual representation
