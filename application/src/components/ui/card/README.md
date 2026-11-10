# Card Component

A versatile card component that provides a container with consistent styling and structure for content organization. The card component includes several sub-components for header, content, footer, title, and description sections.

## Usage

```tsx
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/src/components/ui/card";

export function ExampleCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Card Title</CardTitle>
        <CardDescription>Card description text</CardDescription>
      </CardHeader>
      <CardContent>
        Main content goes here
      </CardContent>
      <CardFooter>
        Footer content
      </CardFooter>
    </Card>
  );
}
```

## Components

### Card
The main container component that wraps all card content.

**Props:**
- Extends `React.HTMLAttributes<HTMLDivElement>`
- `className?: string` - Additional CSS classes to apply
- `children: React.ReactNode` - Card content

### CardHeader
Container for the card's header section, typically containing title and description.

**Props:**
- Extends `React.HTMLAttributes<HTMLDivElement>`
- `className?: string` - Additional CSS classes to apply
- `children: React.ReactNode` - Header content

### CardTitle
Component for the card's main title.

**Props:**
- Extends `React.HTMLAttributes<HTMLHeadingElement>`
- `className?: string` - Additional CSS classes to apply
- `children: React.ReactNode` - Title content

### CardDescription
Component for additional descriptive text below the title.

**Props:**
- Extends `React.HTMLAttributes<HTMLParagraphElement>`
- `className?: string` - Additional CSS classes to apply
- `children: React.ReactNode` - Description content

### CardContent
Container for the card's main content area.

**Props:**
- Extends `React.HTMLAttributes<HTMLDivElement>`
- `className?: string` - Additional CSS classes to apply
- `children: React.ReactNode` - Main content

### CardFooter
Container for the card's footer section.

**Props:**
- Extends `React.HTMLAttributes<HTMLDivElement>`
- `className?: string` - Additional CSS classes to apply
- `children: React.ReactNode` - Footer content

## Styling

The card component uses Tailwind CSS for styling with a modern, clean design:
- Subtle border and shadow effects
- Smooth hover transitions
- Backdrop blur for depth
- Gradient text effects for titles
- Responsive padding and spacing
- Consistent typography

## Accessibility

The component follows accessibility best practices:
- Semantic HTML structure
- Proper heading hierarchy with `<h3>` for titles
- Clear visual hierarchy
- High contrast text colors
- Proper element roles
