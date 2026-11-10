# Dropdown Menu Component

A flexible dropdown menu component built on top of Radix UI's Dropdown Menu primitive. This component provides a fully featured menu system with support for items, checkboxes, radio groups, sub-menus, and keyboard navigation.

## Usage

```tsx
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuCheckboxItem,
} from "@/src/components/ui/dropdown-menu";

export function ExampleDropdownMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Open Menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>My Account</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem>
            Profile
            <DropdownMenuShortcut>⇧⌘P</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem>Settings</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={true}>
          Show Status
        </DropdownMenuCheckboxItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>More Options</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem>Sub Item 1</DropdownMenuItem>
            <DropdownMenuItem>Sub Item 2</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

## Components

### Core Components

#### DropdownMenu
The root component that manages the dropdown state.
- Props: All props from Radix UI's DropdownMenu.Root

#### DropdownMenuTrigger
The button that opens the dropdown menu.
- Props: All props from Radix UI's DropdownMenu.Trigger

#### DropdownMenuContent
The container for the dropdown menu items.
- Props: Extends Radix UI's DropdownMenu.Content
- `sideOffset?: number` - Distance in pixels from the trigger
- `className?: string` - Additional CSS classes

### Menu Items

#### DropdownMenuItem
A basic menu item.
- Props: Extends Radix UI's DropdownMenu.Item
- `inset?: boolean` - Adds left padding matching other items with icons
- `className?: string` - Additional CSS classes

#### DropdownMenuCheckboxItem
A menu item with a checkbox.
- Props: Extends Radix UI's DropdownMenu.CheckboxItem
- `checked?: boolean` - The controlled checked state
- `className?: string` - Additional CSS classes

#### DropdownMenuRadioItem
A menu item that's part of a radio group.
- Props: Extends Radix UI's DropdownMenu.RadioItem
- `className?: string` - Additional CSS classes

### Organization Components

#### DropdownMenuLabel
A label for grouping menu items.
- Props: Extends Radix UI's DropdownMenu.Label
- `inset?: boolean` - Adds left padding matching items with icons
- `className?: string` - Additional CSS classes

#### DropdownMenuSeparator
A visual separator between menu items.
- Props: Extends Radix UI's DropdownMenu.Separator
- `className?: string` - Additional CSS classes

#### DropdownMenuGroup
Groups related menu items.
- Props: All props from Radix UI's DropdownMenu.Group

#### DropdownMenuRadioGroup
Groups related radio items.
- Props: All props from Radix UI's DropdownMenu.RadioGroup

### Sub-menu Components

#### DropdownMenuSub
Container for a sub-menu.
- Props: All props from Radix UI's DropdownMenu.Sub

#### DropdownMenuSubTrigger
The button that opens a sub-menu.
- Props: Extends Radix UI's DropdownMenu.SubTrigger
- `inset?: boolean` - Adds left padding matching items with icons
- `className?: string` - Additional CSS classes

#### DropdownMenuSubContent
The content container for a sub-menu.
- Props: Extends Radix UI's DropdownMenu.SubContent
- `className?: string` - Additional CSS classes

### Utility Components

#### DropdownMenuShortcut
Displays keyboard shortcuts.
- Props: Extends HTMLSpanElement
- `className?: string` - Additional CSS classes

## Styling

The component uses Tailwind CSS for styling with modern features:
- Clean, minimal design
- Smooth animations for open/close states
- Hover and focus states
- Consistent spacing and typography
- Support for icons and shortcuts
- Responsive layout

## Accessibility

Built with accessibility in mind:
- Full keyboard navigation
- ARIA attributes handled by Radix UI
- Focus management
- Screen reader friendly
- Support for RTL languages
- Proper semantic structure

## Best Practices

1. Group related items using DropdownMenuGroup
2. Use separators to organize sections
3. Keep menu items concise
4. Provide keyboard shortcuts for common actions
5. Use icons consistently
6. Consider mobile touch targets
7. Limit nesting depth of sub-menus
