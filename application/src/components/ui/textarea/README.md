# Textarea Component

A customizable textarea component that extends the native HTML textarea with consistent styling and enhanced functionality. This component is designed to work seamlessly with forms and provide a modern, accessible user interface.

## Usage

```tsx
import { Textarea } from "@/src/components/ui/textarea";

export function CommentForm() {
  return (
    <div className="grid w-full gap-2">
      <label htmlFor="comment">Your comment</label>
      <Textarea 
        id="comment"
        placeholder="Type your comment here."
        rows={4}
      />
    </div>
  );
}
```

## Props

The Textarea component extends all native HTML textarea attributes:

| Prop | Type | Description |
|------|------|-------------|
| `className` | `string` | Additional CSS classes |
| `value` | `string` | The value of the textarea |
| `defaultValue` | `string` | Default value for uncontrolled usage |
| `placeholder` | `string` | Placeholder text |
| `rows` | `number` | Number of visible text lines |
| `disabled` | `boolean` | Whether the textarea is disabled |
| `required` | `boolean` | Whether the textarea is required |
| `readOnly` | `boolean` | Whether the textarea is read-only |
| `...props` | `TextareaHTMLAttributes` | All other native textarea attributes |

## Styling

The component uses TailwindCSS with a modern, clean design:

### Base Styles
- Minimum height of 60px
- Full width by default
- Rounded corners (xl)
- Indigo-themed borders and focus states
- Clean white background
- Consistent padding
- Smooth transitions

### Interactive States
- Hover: Light indigo background, darker border
- Focus: Indigo ring and border
- Disabled: Reduced opacity, not-allowed cursor
- Placeholder: Light gray text

## Features

1. **React.forwardRef Support**
   - Allows ref forwarding to the underlying textarea element
   - Enables integration with form libraries
   - Supports custom ref handling

2. **Flexible Styling**
   - Customizable through className prop
   - Consistent with design system
   - Maintains accessibility

3. **Form Integration**
   - Works with React Hook Form
   - Compatible with Formik
   - Supports native form validation

## Best Practices

1. **Accessibility**
   - Always provide associated labels
   - Use aria-* attributes when needed
   - Maintain proper color contrast
   - Consider keyboard navigation

2. **Form Usage**
   - Include proper validation
   - Provide clear error states
   - Use appropriate rows for content
   - Consider maxLength when needed

3. **Mobile Considerations**
   - Test on various screen sizes
   - Ensure touch targets are adequate
   - Consider virtual keyboard impact
   - Test with different input methods

## Examples

### Basic Usage
```tsx
<Textarea placeholder="Enter your message" />
```

### With Form Label
```tsx
<div className="grid gap-1.5">
  <label htmlFor="message">Message</label>
  <Textarea 
    id="message"
    placeholder="Type your message here"
    required
  />
</div>
```

### Disabled State
```tsx
<Textarea 
  placeholder="Disabled textarea"
  disabled
/>
```

### Custom Height
```tsx
<Textarea 
  placeholder="Taller textarea"
  rows={8}
/>
```

### With Character Count
```tsx
function TextareaWithCount() {
  const [value, setValue] = React.useState("")
  
  return (
    <div className="grid gap-1.5">
      <Textarea 
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={500}
      />
      <div className="text-sm text-gray-500">
        {value.length}/500 characters
      </div>
    </div>
  )
}
```

## Form Library Integration

### React Hook Form
```tsx
import { useForm } from "react-hook-form";

function CommentForm() {
  const { register } = useForm();
  
  return (
    <form>
      <Textarea 
        {...register("comment", { required: true })}
        placeholder="Your comment"
      />
    </form>
  );
}
```

### Formik
```tsx
import { Formik, Form } from "formik";

function MessageForm() {
  return (
    <Formik initialValues={{ message: "" }}>
      {({ values, handleChange }) => (
        <Form>
          <Textarea
            name="message"
            value={values.message}
            onChange={handleChange}
          />
        </Form>
      )}
    </Formik>
  );
}
```

## Performance Considerations

- Use controlled components judiciously
- Consider debouncing for real-time validation
- Implement proper memo usage if needed
- Monitor re-render frequency

## Accessibility Features

- Supports native form validation
- Works with screen readers
- Maintains focus states
- Preserves textarea semantics
