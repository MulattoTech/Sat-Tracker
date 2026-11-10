# Side Navigation Component

A responsive side navigation menu that slides in from the left side of the screen, providing access to main application routes and settings. Includes dark mode support with a theme toggle button.

## Features

- Smooth slide-in/out animation with overlay background
- Responsive design that works on both mobile and desktop
- Dark mode support with theme toggle
- Keyboard accessibility (Escape key closes the menu)
- Focus management for improved accessibility
- Clear visual indication of the active route
- Settings button at the bottom of the navigation
- Touch-friendly targets for mobile users

## Components

The Side Navigation system consists of the following components:

1. `SideNav` - The main navigation panel that slides in from the left
2. `SideNavTrigger` - A button that toggles the side navigation visibility
3. `SideNavItem` - Individual navigation items within the side navigation
4. `FooterButton` - Buttons in the footer section, including the theme toggle

## Props

### SideNav Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `isOpen` | `boolean` | Required | Whether the side navigation is open |
| `onClose` | `() => void` | Required | Function to call when the side navigation should be closed |
| `currentPath` | `string` | Required | The current active path |
| `onNavigate` | `(path: string) => void` | Required | Function to call when a navigation item is selected |
| `onSettingsClick` | `() => void` | Required | Function to call when the settings button is clicked |
| `onLogout` | `() => void` | Required | Function to call when the logout button is clicked |
| `isAdmin` | `boolean` | Required | Whether the current user is an admin |
| `className` | `string` | `undefined` | Additional CSS classes to apply to the side navigation |
| `nonModal` | `boolean` | `false` | Whether to render the side nav in non-modal mode (for wide screens) |

### SideNavTrigger Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `onClick` | `() => void` | Required | Function to call when the trigger is clicked |
| `isOpen` | `boolean` | Required | Whether the side navigation is open |
| `className` | `string` | `undefined` | Additional CSS classes to apply to the trigger |
| `children` | `ReactNode` | Required | Children elements (typically the trigger icon) |

### SideNavItem Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `path` | `string` | Required | The path this item navigates to |
| `label` | `string` | Required | The label to display for this item |
| `icon` | `ReactNode` | `undefined` | Optional icon to display next to the label |
| `isActive` | `boolean` | Required | Whether this item is currently active |
| `onClick` | `(path: string) => void` | Required | Function to call when this item is clicked |
| `className` | `string` | `undefined` | Additional CSS classes to apply to the item |

## Usage Examples

### Basic Usage

```tsx
import { useState } from 'react';
import { SideNav, SideNavTrigger } from '@/src/components/ui/side-nav';
import Image from 'next/image';

export function Layout({ children }) {
  const [isOpen, setIsOpen] = useState(false);
  const currentPath = window.location.pathname;
  
  const handleNavigate = (path) => {
    window.location.href = path;
    setIsOpen(false);
  };
  
  const handleSettingsClick = () => {
    // Open settings modal
    setSettingsOpen(true);
    setIsOpen(false);
  };
  
  return (
    <div>
      <header>
        <SideNavTrigger 
          onClick={() => setIsOpen(true)} 
          isOpen={isOpen}
        >
          <Image
            src="/acorn-128.png"
            alt="Menu"
            width={64}
            height={64}
            className="object-contain"
          />
        </SideNavTrigger>
      </header>
      
      <SideNav
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        currentPath={currentPath}
        onNavigate={handleNavigate}
        onSettingsClick={handleSettingsClick}
      />
      
      <main>{children}</main>
    </div>
  );
}
```

## Implementation Details

The Side Navigation component is built using:

- React's `useEffect` for handling keyboard events and body scroll locking
- Tailwind CSS for styling with smooth transitions
- Lucide React for icons
- Class Variance Authority (CVA) for style variants
- Theme context for dark mode support

The component follows a modular structure:
- `index.tsx` - Main component implementation
- `side-nav.styles.ts` - Style definitions using Tailwind classes
- `side-nav.types.ts` - TypeScript type definitions
- `side-nav.css` - Additional CSS for dark mode styling

## Accessibility

The Side Navigation component includes:
- Proper ARIA attributes (`role="dialog"`, `aria-modal="true"`, `aria-label`)
- Keyboard navigation support (Escape key closes the menu)
- Focus management
- Sufficient color contrast for text and interactive elements
- Touch-friendly target sizes for mobile users

## Dark Mode Support

The side navigation includes built-in dark mode support:

1. **Theme Toggle Button**: Located in the footer section, allows users to switch between light and dark modes
2. **Styling Approach**: Uses a hybrid approach with:
   - Tailwind dark mode classes (e.g., `dark:bg-gray-600`) in the styles definition
   - Component-specific CSS overrides in `side-nav.css` for consistent dark mode appearance
3. **Theme Context**: Integrates with the application's theme context to maintain theme state

The dark mode styling includes:
- Dark gray background (`gray-600`)
- Light text colors for better contrast
- Adjusted hover and active states
- Consistent styling across all sub-components

## Mobile Considerations (React Native)

When adapting this component for React Native, consider the following:

- **Animations**: Replace CSS transitions with React Native's Animated API
- **Overlay**: Use React Native's Modal component with a semi-transparent background
- **Touch Handling**: Implement gesture handling for swipe-to-close functionality
- **Keyboard Events**: Use React Native's specific keyboard event handling
- **Styling**: Convert Tailwind classes to React Native StyleSheet or NativeWind
- **Dark Mode**: Implement theme switching using React Native's appearance API or a custom theme context

This component follows the project's cross-platform compatibility guidelines by:
1. Keeping the core logic separate from styling
2. Using a modular structure that can be adapted for different platforms
3. Implementing touch-friendly interactions that work well on mobile
4. Providing clear documentation for platform-specific adaptations
5. Using a theme approach that can be adapted for React Native
