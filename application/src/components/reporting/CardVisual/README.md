# CardVisual Component

A square reporting visual similar to Power BI's card visual that displays a title, main value, and optional comparative value. This component is designed to be used in dashboards and reporting pages to display key metrics.

## Features

- Displays a title, main value, and optional comparative value
- Optional icon support
- Trend indicator with visual styling (positive, negative, neutral)
- Responsive design that works well in grid layouts
- Consistent styling with the application's design system
- Cross-platform compatible design

## Usage

```tsx
import CardVisual from '@/src/components/reporting/CardVisual';
import { Clock } from 'lucide-react';

// Basic usage
<CardVisual
  title="Average Wake Window"
  mainValue="1h 45m"
/>

// With comparative value
<CardVisual
  title="Average Wake Window"
  mainValue="1h 45m"
  comparativeValue="1h 30m (prev)"
  trend="positive"
/>

// With icon
<CardVisual
  title="Average Wake Window"
  mainValue="1h 45m"
  comparativeValue="1h 30m (prev)"
  trend="positive"
  icon={<Clock className="h-4 w-4" />}
/>

// With description
<CardVisual
  title="Average Wake Window"
  mainValue="1h 45m"
  comparativeValue="1h 30m (prev)"
  description="Based on last 7 days"
  trend="positive"
/>
```

## Props

| Prop | Type | Description |
|------|------|-------------|
| `title` | `string` | Title of the card |
| `mainValue` | `string \| number` | Main value to display |
| `comparativeValue` | `string \| number` | Optional comparative value |
| `icon` | `ReactNode` | Optional icon to display |
| `className` | `string` | Optional className for custom styling |
| `description` | `string` | Optional description or subtitle |
| `trend` | `'positive' \| 'negative' \| 'neutral'` | Optional trend indicator |

## Implementation Details

The CardVisual component is built with the following structure:

1. A container with optional trend styling
2. A title section with optional icon
3. A main value section with the primary metric
4. An optional comparative value section with emerald green styling
5. An optional description section

The component uses TailwindCSS for styling and follows the project's design system. The emerald green color used for the comparative value matches the color used in other components like the checkbox.

## Accessibility

- Proper heading hierarchy is used for the title
- Color contrast meets WCAG standards
- Component is keyboard navigable

## Future Enhancements

- Add animation options for value changes
- Support for additional trend visualizations (arrows, sparklines)
- Theme support for light/dark modes
