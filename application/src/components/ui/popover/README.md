# Popover Component

A custom popover component with styled appearance that follows the project's design system. It's designed to be cross-platform compatible with minimal changes required for React Native.

## Features

- Configurable positioning
- Support for custom triggers
- Accessible focus management
- Responsive design
- Animation effects for smooth appearance/disappearance

## Usage

```tsx
import { Popover, PopoverTrigger, PopoverContent } from '@/src/components/ui/popover';

// Basic usage
<Popover>
  <PopoverTrigger>Open Popover</PopoverTrigger>
  <PopoverContent>Popover content</PopoverContent>
</Popover>

// With custom trigger
<Popover>
  <PopoverTrigger asChild>
    <Button>Click me</Button>
  </PopoverTrigger>
  <PopoverContent>Popover content</PopoverContent>
</Popover>

// With positioning
<Popover>
  <PopoverTrigger>Open Popover</PopoverTrigger>
  <PopoverContent align="start" side="right" sideOffset={10}>
    Popover content
  </PopoverContent>
</Popover>
```

## Props

### Popover

The root component that manages the state of the popover.

| Prop | Type | Description |
|------|------|-------------|
| `defaultOpen` | `boolean` | Whether the popover is open by default |
| `open` | `boolean` | Controlled open state |
| `onOpenChange` | `(open: boolean) => void` | Callback when open state changes |

### PopoverTrigger

The trigger element that opens the popover when clicked.

| Prop | Type | Description |
|------|------|-------------|
| `asChild` | `boolean` | When true, the trigger will render its children as a slot |

### PopoverContent

The content of the popover that appears when the trigger is clicked.

| Prop | Type | Description |
|------|------|-------------|
| `className` | `string` | Additional CSS classes |
| `align` | `"start" \| "center" \| "end"` | Alignment of the popover relative to the trigger |
| `side` | `"top" \| "right" \| "bottom" \| "left"` | Side of the trigger where the popover will appear |
| `sideOffset` | `number` | Distance between the popover and the trigger in pixels |

## Styling

The popover uses the app's design system with a clean white background, subtle border, and shadow for depth. It includes smooth animations for a polished user experience.
