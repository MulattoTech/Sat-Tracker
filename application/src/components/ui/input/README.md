# Input Component

A reusable input component with modern styling and full TypeScript support. This component extends the native HTML input element with consistent styling and enhanced functionality.

## Usage

```tsx
import { Input } from "@/src/components/ui/input";

export function ExampleForm() {
  return (
    <div className="space-y-4">
      <Input 
        type="text" 
        placeholder="Enter your name" 
      />
      <Input 
        type="email" 
        placeholder="Enter your email"
        required 
      />
      <Input 
        type="password" 
        placeholder="Enter your password"
        minLength={8}
      />
      <Input 
        type="search" 
        placeholder="Search..."
        className="max-w-sm"
      />
      <Input 
        type="file" 
        accept="image/*"
      />
      <Input 
        type="number" 
        placeholder="Age"
        min={0}
        max={120}
      />
    </div>
  );
}
```

## Props

The Input component extends all native HTML input attributes:

- `type?: string` - Input type (text, password, email, etc.)
- `placeholder?: string` - Placeholder text
- `disabled?: boolean` - Disables the input
- `required?: boolean` - Makes the input required
- `className?: string` - Additional CSS classes
- All other HTML input attributes are supported

## Styling

The component uses Tailwind CSS with a modern, clean design:

### Base Styles
- Consistent height and width
- Rounded corners (xl)
- Indigo-themed borders and focus states
- Smooth transitions
- Proper spacing with padding
- Responsive text size

### Interactive States
- Hover: Light indigo background, darker border
- Focus: Indigo ring and border
- Disabled: Reduced opacity, not-allowed cursor

### Special Elements
- File input styling
- Placeholder text styling
- Disabled state styling

## Accessibility

The component follows accessibility best practices:
- Proper focus states
- Keyboard navigation support
- Screen reader friendly
- Clear visual feedback
- Disabled state indication

## Best Practices

1. Always provide descriptive placeholders
2. Use appropriate input types for data
3. Include validation attributes when needed
4. Group related inputs in forms
5. Add proper labels (using HTML `<label>`)
6. Consider mobile input methods
7. Implement proper form validation

## Form Integration

The Input component works seamlessly with:
- React Hook Form
- Formik
- Native HTML forms
- Custom form implementations

## Examples

### Basic Text Input
```tsx
<Input type="text" placeholder="Enter text" />
```

### Required Email Input
```tsx
<Input 
  type="email" 
  placeholder="Email address" 
  required 
/>
```

### Password Input with Validation
```tsx
<Input 
  type="password" 
  placeholder="Password" 
  minLength={8}
  required 
/>
```

### Custom Styled Input
```tsx
<Input 
  type="text" 
  className="max-w-md bg-gray-50" 
  placeholder="Custom styled input" 
/>
```

### Disabled Input
```tsx
<Input 
  type="text" 
  disabled 
  value="Disabled input" 
/>
```

### Number Input with Constraints
```tsx
<Input 
  type="number" 
  min={0} 
  max={100} 
  step={1} 
  placeholder="Enter a number" 
/>
```
