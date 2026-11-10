# Theme System Documentation

This document provides guidance on implementing and using the dark mode theme system in the Baby Tracker application.

## Overview

The application includes a theme system that supports both light and dark modes. The theme state is managed through a React context and persisted in localStorage. The system uses a hybrid approach to styling:

1. **Tailwind Dark Mode Classes**: Using `dark:` prefix classes in component styles
2. **Component-specific CSS**: For components that need custom dark mode styling

## Theme Context

The theme context (`src/context/theme.tsx`) provides the core functionality:

```tsx
import { useTheme } from '@/src/context/theme';

function MyComponent() {
  const { theme, toggleTheme } = useTheme();
  
  return (
    <div>
      <p>Current theme: {theme}</p>
      <button onClick={toggleTheme}>
        Switch to {theme === 'light' ? 'dark' : 'light'} mode
      </button>
    </div>
  );
}
```

### Features

- **Theme State**: Tracks whether the app is in `'light'` or `'dark'` mode
- **Toggle Function**: Switches between light and dark modes
- **Persistence**: Saves theme preference to localStorage
- **HTML Class**: Adds/removes the `dark` class on the HTML element

## Implementation Approaches

### 1. Using Tailwind Dark Mode Classes (Preferred)

For most components, use Tailwind's dark mode classes in your style definitions:

```tsx
// In a styles.ts file
export const buttonStyles = "bg-white text-gray-800 dark:bg-gray-800 dark:text-white";

// Or directly in components
<div className="bg-white dark:bg-gray-800 text-black dark:text-white">
  Dark mode compatible content
</div>
```

### 2. Component-specific CSS (For Complex Components)

For components with complex dark mode styling needs:

1. Create a component-specific CSS file (e.g., `component-name.css`)
2. Add dark mode styles using the `html.dark` selector:

```css
/* component-name.css */
html.dark .component-class {
  background-color: #374151;
  color: #e5e7eb;
}

html.dark .component-class:hover {
  background-color: #4b5563;
}
```

3. Import the CSS file in your component:

```tsx
import './component-name.css';
```

4. Add the corresponding class to your component:

```tsx
<div className="component-class">
  This will use the dark mode styles when dark mode is active
</div>
```

## Adding Dark Mode to a New Component

1. **Add Theme Context**: Import and use the theme context in your component
2. **Style with Tailwind**: Use Tailwind's dark mode classes for basic styling
3. **Add CSS if Needed**: For complex styling, create a component-specific CSS file
4. **Test Both Modes**: Ensure your component looks good in both light and dark modes

## Example: Theme Toggle Button

```tsx
import { useTheme } from '@/src/context/theme';
import { Moon, Sun } from 'lucide-react';

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  
  return (
    <button 
      onClick={toggleTheme}
      className="p-2 rounded-full bg-gray-200 dark:bg-gray-700"
      aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
    >
      {theme === 'light' ? (
        <Moon className="w-5 h-5 text-gray-800" />
      ) : (
        <Sun className="w-5 h-5 text-yellow-300" />
      )}
    </button>
  );
}
```

## React Native Considerations

When adapting the theme system for React Native:

1. **Theme Context**: Keep the same context structure but modify the implementation
2. **Storage**: Use AsyncStorage instead of localStorage
3. **Styling**: Replace Tailwind and CSS with React Native StyleSheet
4. **Theme Application**: Instead of HTML classes, use theme-based StyleSheet objects

Example React Native approach:

```tsx
// Theme context for React Native
const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>('light');
  
  // Load theme from AsyncStorage on mount
  useEffect(() => {
    const loadTheme = async () => {
      try {
        const savedTheme = await AsyncStorage.getItem('theme') as Theme;
        if (savedTheme) {
          setTheme(savedTheme);
        }
      } catch (e) {
        console.error('Failed to load theme', e);
      }
    };
    
    loadTheme();
  }, []);
  
  const toggleTheme = async () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    try {
      await AsyncStorage.setItem('theme', newTheme);
    } catch (e) {
      console.error('Failed to save theme', e);
    }
  };
  
  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
```

## Best Practices

1. **Consistent Colors**: Use the same color palette across components
2. **Contrast Ratios**: Ensure text has sufficient contrast in both modes
3. **Test Transitions**: Make sure switching between modes is smooth
4. **Component Isolation**: Keep dark mode styles with their components
5. **Documentation**: Document dark mode support in component READMEs
