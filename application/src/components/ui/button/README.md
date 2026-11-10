# Button Component

A versatile button component with multiple variants and sizes, built with accessibility and customization in mind.

## Features

- Multiple visual variants (default, destructive, outline, secondary, ghost, link, success, info, warning)
- Multiple size options (default, sm, lg, xl, icon)
- Support for all standard button HTML attributes
- Accessible focus states with keyboard navigation support
- Smooth transitions and hover effects
- Support for rendering as a different element using `asChild` prop

## Props

The Button component accepts all standard HTML button attributes plus the following:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `variant` | `'default' \| 'destructive' \| 'outline' \| 'secondary' \| 'ghost' \| 'link' \| 'success' \| 'info' \| 'warning'` | `'default'` | Visual style variant of the button |
| `size` | `'default' \| 'sm' \| 'lg' \| 'xl' \| 'icon'` | `'default'` | Size variant of the button |
| `asChild` | `boolean` | `false` | When true, the button will render its children as a slot (useful for custom button implementations) |
| `className` | `string` | `undefined` | Additional CSS classes to apply to the button |

## Usage Examples

### Basic Button

```tsx
import { Button } from "@/components/ui/button"

export function MyComponent() {
  return (
    <Button onClick={() => console.log("Button clicked")}>
      Click Me
    </Button>
  )
}
```

### Button Variants

```tsx
import { Button } from "@/components/ui/button"

export function ButtonVariants() {
  return (
    <div className="flex flex-col gap-4">
      <Button variant="default">Default Button</Button>
      <Button variant="destructive">Destructive Button</Button>
      <Button variant="outline">Outline Button</Button>
      <Button variant="secondary">Secondary Button</Button>
      <Button variant="ghost">Ghost Button</Button>
      <Button variant="link">Link Button</Button>
      <Button variant="success">Success Button</Button>
      <Button variant="info">Info Button</Button>
      <Button variant="warning">Warning Button</Button>
    </div>
  )
}
```

### Button Sizes

```tsx
import { Button } from "@/components/ui/button"

export function ButtonSizes() {
  return (
    <div className="flex flex-wrap gap-4 items-end">
      <Button size="sm">Small Button</Button>
      <Button size="default">Default Button</Button>
      <Button size="lg">Large Button</Button>
      <Button size="xl">Extra Large Button</Button>
      <Button size="icon">
        <span className="material-icons">add</span>
      </Button>
    </div>
  )
}
```

### Using as a Link

```tsx
import Link from "next/link"
import { Button } from "@/components/ui/button"

export function LinkButton() {
  return (
    <Button asChild>
      <Link href="/dashboard">Go to Dashboard</Link>
    </Button>
  )
}
```

## Implementation Details

The Button component is built using:

- React's `forwardRef` for proper ref forwarding
- Radix UI's `Slot` component for the `asChild` functionality
- Class Variance Authority (CVA) for variant management
- TailwindCSS for styling

The component follows a modular structure:
- `index.tsx` - Main component implementation
- `button.styles.ts` - Style definitions using CVA
- `button.types.ts` - TypeScript type definitions

## Accessibility

The Button component includes:
- Proper focus states with visible outlines
- Disabled state styling
- Support for all standard button attributes including `aria-*` props
- Keyboard navigation support

## Mobile Considerations (React Native)

When adapting this component for React Native, consider the following:

- **Styling**: The TailwindCSS classes will need to be replaced with React Native's StyleSheet or a compatible styling solution like NativeWind
- **Touch Targets**: The button sizes are already designed with touch interactions in mind (minimum 44x44 points for touch targets)
- **Transitions**: React Native handles animations differently, so the transition effects will need to be implemented using the Animated API
- **Gradient Backgrounds**: The gradient backgrounds will need to be implemented using a library like `react-native-linear-gradient`
- **Hover States**: React Native doesn't have hover states, so these interactions will need alternative implementations
- **Focus States**: Focus handling is different in React Native and will need platform-specific implementations

This component follows the project's cross-platform compatibility guidelines by:
1. Keeping the core logic separate from styling
2. Using a modular structure that can be adapted for different platforms
3. Avoiding web-specific APIs in the core component logic
4. Documenting all aspects that will need platform-specific implementations