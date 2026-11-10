# Select Component

A customizable select component built on top of Radix UI's Select primitive. This component provides a fully accessible dropdown select with support for grouping, labels, and custom styling.

## Usage

```tsx
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
  SelectSeparator,
} from "@/src/components/ui/select";

export function ExampleSelect() {
  return (
    <Select>
      <SelectTrigger className="w-[200px]">
        <SelectValue placeholder="Select a fruit" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Fruits</SelectLabel>
          <SelectItem value="apple">Apple</SelectItem>
          <SelectItem value="banana">Banana</SelectItem>
          <SelectItem value="orange">Orange</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Vegetables</SelectLabel>
          <SelectItem value="carrot">Carrot</SelectItem>
          <SelectItem value="potato">Potato</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
```

## Components

### Select
The root component that manages the select state.
- Props: All props from Radix UI's Select.Root

### SelectTrigger
The button that opens the select menu.
- Props: Extends Radix UI's Select.Trigger
- `className?: string` - Additional CSS classes

### SelectValue
The component that displays the selected value.
- Props: All props from Radix UI's Select.Value

### SelectContent
The dropdown content container.
- Props: Extends Radix UI's Select.Content
- `position?: "item" | "popper"` - Positioning strategy
- `className?: string` - Additional CSS classes

### SelectGroup
Groups related select items.
- Props: All props from Radix UI's Select.Group

### SelectLabel
Label for a group of items.
- Props: Extends Radix UI's Select.Label
- `className?: string` - Additional CSS classes

### SelectItem
Individual selectable item.
- Props: Extends Radix UI's Select.Item
- `className?: string` - Additional CSS classes
- `value: string` - The value of the item

### SelectSeparator
Visual separator between items or groups.
- Props: Extends Radix UI's Select.Separator
- `className?: string` - Additional CSS classes

### SelectScrollUpButton & SelectScrollDownButton
Buttons for scrolling through content.
- Props: Extend respective Radix UI components
- `className?: string` - Additional CSS classes

## Styling

The component uses TailwindCSS with a modern, clean design:

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

### Animations
- Smooth fade in/out
- Zoom animations
- Slide animations based on position

## Accessibility

Built with accessibility in mind through Radix UI:
- Full keyboard navigation (Arrow keys, Enter, Space, Escape)
- ARIA attributes automatically managed
- Screen reader announcements
- Focus management
- Touch-friendly targets
- Support for RTL languages

## Form Integration

Works seamlessly with:
- React Hook Form
- Formik
- Native HTML forms
- Custom form implementations

## Examples

### Basic Select
```tsx
<Select>
  <SelectTrigger>
    <SelectValue placeholder="Select option" />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="1">Option 1</SelectItem>
    <SelectItem value="2">Option 2</SelectItem>
  </SelectContent>
</Select>
```

### Grouped Select with Labels
```tsx
<Select>
  <SelectTrigger>
    <SelectValue placeholder="Select category" />
  </SelectTrigger>
  <SelectContent>
    <SelectGroup>
      <SelectLabel>Category A</SelectLabel>
      <SelectItem value="a1">Item A1</SelectItem>
      <SelectItem value="a2">Item A2</SelectItem>
    </SelectGroup>
    <SelectSeparator />
    <SelectGroup>
      <SelectLabel>Category B</SelectLabel>
      <SelectItem value="b1">Item B1</SelectItem>
      <SelectItem value="b2">Item B2</SelectItem>
    </SelectGroup>
  </SelectContent>
</Select>
```

### Disabled Select
```tsx
<Select disabled>
  <SelectTrigger>
    <SelectValue placeholder="Disabled" />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="1">Option 1</SelectItem>
  </SelectContent>
</Select>
```

## Best Practices

1. Always provide meaningful labels and placeholders
2. Group related options using SelectGroup
3. Use SelectLabel to provide context for groups
4. Keep option lists manageable in length
5. Consider mobile touch targets
6. Implement proper form validation
7. Handle loading and error states appropriately

## Mobile Considerations

- Touch-friendly target sizes
- Proper viewport handling
- Smooth scrolling support
- Native-like feel on mobile devices
- Support for touch gestures
