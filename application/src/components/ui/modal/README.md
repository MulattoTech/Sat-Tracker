# Modal Component

A flexible and reusable modal component built on top of Radix UI's Dialog primitive. This component provides a consistent modal interface with customizable header, content, and footer sections.

## Usage

```tsx
import { Modal, ModalContent, ModalFooter } from "@/src/components/ui/modal";
import { Button } from "@/src/components/ui/button";

export function ExampleModal() {
  const [open, setOpen] = useState(false);

  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      title="Example Modal"
      description="This is a description of the modal"
    >
      <ModalContent>
        <div className="space-y-4">
          {/* Your modal content here */}
        </div>
      </ModalContent>
      <ModalFooter>
        <Button variant="outline" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button onClick={() => setOpen(false)}>
          Confirm
        </Button>
      </ModalFooter>
    </Modal>
  );
}
```

## Components

### Modal
The root modal component that manages the dialog state.

#### Props
| Prop | Type | Description |
|------|------|-------------|
| `open` | `boolean` | Whether the modal is currently open |
| `onOpenChange` | `(open: boolean) => void` | Callback when the modal should close |
| `title` | `string` | Title of the modal |
| `description?` | `string` | Optional description below the title |
| `children` | `ReactNode` | Content of the modal |
| `className?` | `string` | Additional CSS classes |

### ModalContent
Container for the main content of the modal.

#### Props
| Prop | Type | Description |
|------|------|-------------|
| `children` | `ReactNode` | Content of the modal |
| `className?` | `string` | Additional CSS classes |

### ModalFooter
Container for the modal's action buttons.

#### Props
| Prop | Type | Description |
|------|------|-------------|
| `children` | `ReactNode` | Footer content (typically buttons) |
| `className?` | `string` | Additional CSS classes |

## Styling

The component uses TailwindCSS with a consistent design:

### Base Styles
- Proper padding and spacing
- Responsive design
- Clean typography
- Smooth transitions
- Proper z-indexing

### Header Styles
- Clear title hierarchy
- Muted description text
- Consistent spacing

### Content Styles
- Flexible content area
- Form-friendly spacing
- Scrollable when needed

### Footer Styles
- Right-aligned buttons
- Proper button spacing
- Clear action hierarchy

## Examples

### Form Modal
```tsx
import { Modal, ModalContent, ModalFooter } from "@/src/components/ui/modal";
import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/input";

function FormModal() {
  const [open, setOpen] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Handle form submission
    setOpen(false);
  };

  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      title="Create Item"
      description="Enter the details for your new item"
    >
      <form onSubmit={handleSubmit}>
        <ModalContent>
          <div className="space-y-4">
            <div>
              <label className="form-label">Name</label>
              <Input required />
            </div>
            <div>
              <label className="form-label">Description</label>
              <Input />
            </div>
          </div>
        </ModalContent>
        <ModalFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="submit">
            Create
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
```

### Confirmation Modal
```tsx
import { Modal, ModalContent, ModalFooter } from "@/src/components/ui/modal";
import { Button } from "@/src/components/ui/button";

function ConfirmationModal() {
  const [open, setOpen] = useState(false);

  const handleConfirm = () => {
    // Handle confirmation
    setOpen(false);
  };

  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      title="Confirm Action"
      description="Are you sure you want to proceed?"
    >
      <ModalContent>
        <p>This action cannot be undone.</p>
      </ModalContent>
      <ModalFooter>
        <Button variant="outline" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={handleConfirm}>
          Delete
        </Button>
      </ModalFooter>
    </Modal>
  );
}
```

## Best Practices

1. **Form Handling**
   - Use form elements for data collection
   - Implement proper validation
   - Handle submission states
   - Provide clear feedback

2. **Accessibility**
   - Maintain keyboard navigation
   - Use proper ARIA attributes
   - Ensure focus management
   - Support screen readers

3. **Mobile Considerations**
   - Test on various screen sizes
   - Ensure touch targets are adequate
   - Handle virtual keyboard properly
   - Consider gesture interactions

4. **State Management**
   - Handle loading states
   - Manage form data properly
   - Handle errors gracefully
   - Implement proper validation

5. **Performance**
   - Lazy load modal content when possible
   - Optimize animations
   - Clean up event listeners
   - Handle large forms efficiently

## Integration Tips

1. **Form Libraries**
   - Works with React Hook Form
   - Compatible with Formik
   - Supports native form validation
   - Easy to integrate with custom form solutions

2. **State Management**
   - Can be controlled via external state
   - Supports local state management
   - Works with context providers
   - Handles complex form state

3. **Animation**
   - Built-in transitions
   - Customizable animations
   - Smooth enter/exit
   - Mobile-friendly animations
