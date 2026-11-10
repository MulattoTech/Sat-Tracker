# Dialog Component

A flexible dialog component built on top of Radix UI's Dialog primitive. This component provides a modal dialog that can be triggered, with support for headers, content, footers, and customizable animations.

## Usage

```tsx
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose
} from "@/src/components/ui/dialog";

export function ExampleDialog() {
  return (
    <Dialog>
      <DialogTrigger>Open Dialog</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Dialog Title</DialogTitle>
          <DialogDescription>Dialog description text</DialogDescription>
        </DialogHeader>
        <div>Main content goes here</div>
        <DialogFooter>
          <DialogClose>Close</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

## Components

### Dialog
The root component that manages the dialog state.

**Props:**
- All props from Radix UI's Dialog.Root

### DialogTrigger
The button that opens the dialog.

**Props:**
- All props from Radix UI's Dialog.Trigger

### DialogContent
The component that renders the dialog content and overlay.

**Props:**
- Extends Radix UI's Dialog.Content props
- `hideClose?: boolean` - Option to hide the close button
- `className?: string` - Additional CSS classes
- `children: React.ReactNode` - Dialog content

### DialogHeader
Container for the dialog's header section.

**Props:**
- Extends `HTMLDivElement` props
- `className?: string` - Additional CSS classes
- `children: React.ReactNode` - Header content

### DialogFooter
Container for the dialog's footer section.

**Props:**
- Extends `HTMLDivElement` props
- `className?: string` - Additional CSS classes
- `children: React.ReactNode` - Footer content

### DialogTitle
Component for the dialog's title.

**Props:**
- Extends Radix UI's Dialog.Title props
- `className?: string` - Additional CSS classes
- `children: React.ReactNode` - Title content

### DialogDescription
Component for the dialog's description text.

**Props:**
- Extends Radix UI's Dialog.Description props
- `className?: string` - Additional CSS classes
- `children: React.ReactNode` - Description content

## Styling

The dialog component uses Tailwind CSS for styling with modern design features:
- Backdrop blur effect
- Smooth animations for open/close states
- Responsive layout
- Mobile-friendly design
- Customizable through className props

### Animations
The dialog includes several animations:
- Fade in/out for overlay
- Zoom and slide animations for content
- Smooth transitions for hover states

## Accessibility

Built with accessibility in mind:
- Uses semantic HTML through Radix UI primitives
- Manages focus automatically
- Provides keyboard navigation
- Includes proper ARIA attributes
- Screen reader friendly with descriptive labels
- Close button has proper aria-label

## Best Practices

1. Always provide a clear title and description
2. Use the DialogHeader and DialogFooter for consistent layout
3. Consider mobile viewports when adding content
4. Keep content concise and focused
5. Provide clear action buttons in the footer
6. Use the hideClose prop only when providing alternative close actions
