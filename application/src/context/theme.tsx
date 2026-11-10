'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';

type Theme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  useSystemTheme: boolean;
  toggleTheme: () => void;
  toggleUseSystemTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Initialize useSystemTheme state - default to false
  const [useSystemTheme, setUseSystemTheme] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false; // Default for SSR
    const savedUseSystemTheme = localStorage.getItem('useSystemTheme');
    return savedUseSystemTheme === null ? false : savedUseSystemTheme === 'true';
  });

  // Initialize theme state based on localStorage, system preference, or default
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'light'; // Default for SSR
    
    // If using system theme, check system preference
    if (useSystemTheme) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    
    // Otherwise use saved theme or default to light
    const savedTheme = localStorage.getItem('theme') as Theme;
    return savedTheme || 'light';
  });

  // Effect to apply theme class to HTML element and listen for system changes
  useEffect(() => {
    if (typeof window !== 'undefined') {
      // Apply the current theme state to the DOM
      if (theme === 'dark') {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }

      // Listener for system theme changes - only active when useSystemTheme is true
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = (e: MediaQueryListEvent) => {
        if (useSystemTheme) {
          const systemTheme: Theme = e.matches ? 'dark' : 'light';
          setTheme(systemTheme);
        }
      };

      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }
  }, [theme, useSystemTheme]); // Re-run this effect when theme or useSystemTheme changes

  // Update theme based on system preference when useSystemTheme changes
  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (useSystemTheme) {
        // If using system theme, update theme based on system preference
        const systemTheme: Theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        setTheme(systemTheme);
      } else {
        // If not using system theme, use the saved theme or default to light
        const savedTheme = localStorage.getItem('theme') as Theme;
        if (savedTheme) {
          setTheme(savedTheme);
        }
      }
    }
  }, [useSystemTheme]);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    
    // Only save to localStorage if not using system theme
    if (!useSystemTheme) {
      localStorage.setItem('theme', newTheme);
    }
    
    // Update the theme state, triggering the useEffect to update the DOM
    setTheme(newTheme);

    // Optional: Keep debug info if needed
    console.log('Theme toggled to:', newTheme);
    console.log('Using system theme:', useSystemTheme);
    console.log('localStorage theme:', localStorage.getItem('theme'));
    console.log('Dark class present:', document.documentElement.classList.contains('dark'));
  };
  
  const toggleUseSystemTheme = () => {
    const newUseSystemTheme = !useSystemTheme;
    
    // Save the preference to localStorage
    localStorage.setItem('useSystemTheme', String(newUseSystemTheme));
    
    // Update the state
    setUseSystemTheme(newUseSystemTheme);
    
    // If switching to system theme, update theme immediately based on system preference
    if (newUseSystemTheme && typeof window !== 'undefined') {
      const systemTheme: Theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      setTheme(systemTheme);
    }
    
    console.log('Use system theme toggled to:', newUseSystemTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, useSystemTheme, toggleTheme, toggleUseSystemTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
