# Label Component

A flexible and accessible label component built on top of Radix UI's Label primitive. This component provides consistent styling and behavior for form labels while maintaining proper accessibility standards.

## Usage

```tsx
import { Label } from "@/src/components/ui/label";

export function FormField() {
  return (
    <div className="grid gap-2">
      <Label htmlFor="email">Email</Label>
      <input type="email" id="email" />
    </div>
  );
}
```

## Props

The Label component extends all native HTML label attributes through Radix UI's Label primitive:

| Prop | Type | Description |
|------|------|-------------|
| `htmlFor` | `string` | Associates the label with a form control |
| `className` | `string` | Additional CSS classes |
| `children` | `ReactNode` | Label content |
| `...props` | `LabelHTMLAttributes` | All other native label attributes |

## Styling

The component uses TailwindCSS with a consistent design:

### Base Styles
- Small text size (text-sm)
- Medium font weight
- No line height (leading-none)
- Proper disabled states for peer elements

### Interactive States
- Disabled cursor when peer is disabled
- Reduced opacity when peer is disabled
- Maintains readability in all states

## Features

1. **Accessibility**
   - Proper label semantics
   - Screen reader support
   - Keyboard navigation support
   - Focus management

2. **Form Integration**
   - Works with all form controls
   - Supports peer states
   - Maintains proper associations

3. **Styling**
   - Consistent text sizing
   - Proper font weights
   - Clear disabled states
   - Customizable through className

## Examples

### Basic Label
```tsx
<Label htmlFor="name">Name</Label>
```

### With Form Control
```tsx
<div className="grid gap-2">
  <Label htmlFor="username">Username</Label>
  <Input id="username" />
</div>
```

### Required Field
```tsx
<div className="grid gap-2">
  <Label htmlFor="password">
    Password <span className="text-red-500">*</span>
  </Label>
  <Input id="password" type="password" required />
</div>
```

### With Description
```tsx
<div className="grid gap-1">
  <Label htmlFor="bio">Bio</Label>
  <Textarea id="bio" />
  <p className="text-sm text-gray-500">
    Write a short description about yourself.
  </p>
</div>
```

### Disabled State
```tsx
<div className="grid gap-2">
  <Label htmlFor="disabled-input">Disabled Field</Label>
  <Input id="disabled-input" disabled />
</div>
```

## Best Practices

1. **Accessibility**
   - Always use htmlFor to associate with form controls
   - Provide clear, descriptive label text
   - Consider screen reader users
   - Maintain proper contrast

2. **Form Design**
   - Keep labels concise
   - Indicate required fields consistently
   - Group related fields
   - Provide clear instructions

3. **Mobile Considerations**
   - Ensure touch targets are adequate
   - Maintain readability on small screens
   - Consider form layout on mobile
   - Test with various screen sizes

4. **Error States**
   - Clearly indicate validation errors
   - Provide error messages near labels
   - Use consistent error styling
   - Maintain accessibility in error states

## Integration Tips

1. **Form Libraries**
   - Works with React Hook Form
   - Compatible with Formik
   - Supports native form validation
   - Easy to integrate with custom solutions

2. **Styling**
   - Use className for custom styles
   - Maintain consistent spacing
   - Follow design system guidelines
   - Consider dark mode support

3. **Validation**
   - Show required indicators
   - Display validation states
   - Provide clear feedback
   - Maintain accessibility

## Performance Considerations

- Minimal bundle size
- No unnecessary re-renders
- Efficient class variance handling
- Proper prop memoization
